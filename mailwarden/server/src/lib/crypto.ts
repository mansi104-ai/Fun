import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = Buffer.from(config.tokenEncryptionKey, "hex");
  if (raw.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes of hex (64 hex chars).");
  }
  return raw;
}

/** Encrypts a Gmail refresh token for storage. Format: iv.tag.ciphertext (base64url). */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString("base64url")).join(".");
}

export function decryptToken(encoded: string): string {
  const [ivB64, tagB64, ctB64] = encoded.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Malformed encrypted token.");
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Subjects are never stored in plaintext — we keep a salted hash purely so the
 * OTP/receipt detectors can spot repeated templates from one sender without
 * retaining readable content. See docs/03 §4.
 */
export function hashSubject(subject: string): string {
  return createHash("sha256")
    .update(config.sessionSecret)
    .update("\x00subject\x00")
    .update(subject.trim().toLowerCase())
    .digest("base64url")
    .slice(0, 22);
}

export function signSession(userId: string): string {
  const payload = Buffer.from(userId, "utf8").toString("base64url");
  const mac = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifySession(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const [payload, mac] = cookie.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(payload, "base64url").toString("utf8");
}

export const newId = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`;
