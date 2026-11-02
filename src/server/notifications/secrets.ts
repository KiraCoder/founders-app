import "server-only";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Constant-time string comparison. Both sides are hashed first so the comparison
 * does not leak the secret's length either.
 */
export function safeEqual(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Reads "Authorization: Bearer X" or a custom header. */
export function bearerToken(req: Request, fallbackHeader?: string): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return fallbackHeader ? req.headers.get(fallbackHeader) : null;
}

// No 0/O/1/I/L to avoid typos when a founder types the code by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Human-typeable one-time code, e.g. "K7QM-3XRP" (8 chars, ~40 bits). */
export function randomLinkCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Normalizes user input ("k7qm 3xrp", "K7QM3XRP") to the canonical form. */
export function normalizeLinkCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 8) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Opaque token for inline buttons (fits Telegram's 64-byte callback_data). */
export function randomToken(): string {
  return randomBytes(16).toString("base64url");
}
