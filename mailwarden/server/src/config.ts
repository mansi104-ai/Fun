import { randomBytes } from "node:crypto";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. See .env.example.`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const isProd = process.env.NODE_ENV === "production";

/**
 * In dev we generate ephemeral keys so the app boots from a bare clone.
 * In production both must be supplied — a rotating token key would orphan every
 * stored Gmail refresh token on restart.
 */
function secretOrEphemeral(name: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required env var in production: ${name}`);
  const generated = randomBytes(32).toString("hex");
  console.warn(
    `[config] ${name} not set — generated an ephemeral dev key. ` +
      `Anything encrypted with it is unreadable after restart.`,
  );
  return generated;
}

export const config = {
  isProd,
  port: Number(optional("PORT", "8080")),
  appUrl: optional("APP_URL", "http://localhost:8080"),

  tokenEncryptionKey: secretOrEphemeral("TOKEN_ENCRYPTION_KEY"),
  sessionSecret: secretOrEphemeral("SESSION_SECRET"),

  google: {
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    get redirectUri() {
      return `${config.appUrl}/auth/google/callback`;
    },
    /**
     * gmail.modify is the narrowest scope that can archive, label, and trash.
     * It CANNOT permanently delete — which is both the product promise and the
     * reason we stay in CASA Tier 2. Never add https://mail.google.com/.
     * See docs/03-compliance-and-launch-path.md.
     */
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    // OpenRouter's free lineup ROTATES — slugs are retired without notice, and
    // a retired slug returns 404, which previously degraded classification
    // silently. Verify with `GET https://openrouter.ai/api/v1/models` if the
    // logs start showing openrouter request failures.
    model: optional("OPENROUTER_MODEL", "nvidia/nemotron-3-super-120b-a12b:free"),
    dailyRequestBudget: Number(optional("OPENROUTER_DAILY_REQUEST_BUDGET", "50")),
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: optional("ANTHROPIC_MODEL", "claude-sonnet-5"),
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    priceFounding: process.env.STRIPE_PRICE_ID_FOUNDING ?? "",
    priceStarter: process.env.STRIPE_PRICE_ID_STARTER ?? "",
    pricePro: process.env.STRIPE_PRICE_ID_PRO ?? "",
  },

  /**
   * Direct payment, which carries no processor fee at all.
   *
   * UPI has zero merchant discount rate in India by regulation, so a founding
   * seat bought this way costs 0% instead of ~3.5%. It requires the operator to
   * confirm the payment by hand — which is free, because every buyer already
   * has to be added to the Google Test users list manually.
   */
  direct: {
    upiId: process.env.DIRECT_UPI_ID ?? "",
    payeeName: optional("DIRECT_PAYEE_NAME", "Mailwarden"),
    note: process.env.DIRECT_PAY_NOTE ?? "",
  },

  /**
   * Accounts allowed to grant plans by hand — comma-separated, compared
   * case-insensitively against the SIGNED-IN user email.
   *
   * Note that is the Google account used to sign into Mailwarden, not a
   * business address. Setting it to an address that never signs in locks the
   * operator out of their own admin endpoint with a silent 403.
   *
   * Empty disables manual granting entirely. An unset admin must mean nobody,
   * never everybody.
   */
  adminEmails: (process.env.ADMIN_EMAIL ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  /**
   * Where operator alerts go — a Telegram/Discord/Slack/Zapier webhook URL.
   * Unset means alerts are logged only, which is exactly how a lead-capture
   * form ends up filling a table nobody reads.
   */
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL ?? "",

  databasePath: optional("DATABASE_PATH", "./mailwarden.db"),

  /** Gmail messages.get quota is the sync bottleneck; keep concurrency modest. */
  sync: {
    pageSize: 500,
    metadataConcurrency: 12,
    maxMessagesFreeTier: 25_000,
  },
} as const;
