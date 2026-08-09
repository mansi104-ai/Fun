import { google, type gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";
import { db } from "../db.js";
import { decryptToken } from "../lib/crypto.js";

export function oauthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

export function consentUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh token on repeat authorisations
    scope: [...config.google.scopes],
    state,
    include_granted_scopes: true,
  });
}

export class ReconnectRequired extends Error {
  constructor(public accountId: string) {
    super("Gmail authorisation expired — the user must reconnect.");
    this.name = "ReconnectRequired";
  }
}

/**
 * Builds an authorised Gmail client for a stored account.
 *
 * Note for beta: while the OAuth app is in Testing status, Google expires
 * refresh tokens for external test users on a short cycle. When that happens
 * we mark the account `needs_reconnect` and surface a reconnect prompt rather
 * than failing silently — see docs/03-compliance-and-launch-path.md §2.
 */
export async function gmailFor(accountId: string): Promise<gmail_v1.Gmail> {
  const row = db
    .prepare(`SELECT refresh_token_enc FROM accounts WHERE id = ?`)
    .get(accountId) as { refresh_token_enc: string } | undefined;
  if (!row) throw new Error(`Unknown account: ${accountId}`);

  // A token we cannot decrypt is operationally identical to one that expired:
  // the user must reconnect. This also covers a rotated TOKEN_ENCRYPTION_KEY,
  // which would otherwise surface to every user as an opaque 500.
  let refreshToken: string;
  try {
    refreshToken = decryptToken(row.refresh_token_enc);
  } catch {
    db.prepare(`UPDATE accounts SET sync_state = 'needs_reconnect' WHERE id = ?`).run(accountId);
    throw new ReconnectRequired(accountId);
  }

  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refreshToken });

  try {
    await auth.getAccessToken();
  } catch {
    db.prepare(`UPDATE accounts SET sync_state = 'needs_reconnect' WHERE id = ?`).run(accountId);
    throw new ReconnectRequired(accountId);
  }

  return google.gmail({ version: "v1", auth });
}

/** "Acme Deals <deals@acme.com>" -> { name: "Acme Deals", key: "deals@acme.com" } */
export function parseFrom(raw: string | undefined): { name: string | null; key: string } | null {
  if (!raw) return null;
  const angled = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  const address = (angled?.[2] ?? raw).trim().toLowerCase();
  if (!address.includes("@")) return null;
  const name = angled?.[1]?.replace(/^["']|["']$/g, "").trim() || null;
  return { name: name || null, key: address };
}

export const domainOf = (senderKey: string): string => senderKey.split("@")[1] ?? "unknown";
