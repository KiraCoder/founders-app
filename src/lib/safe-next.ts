/**
 * Where to go after sign-in. Only same-origin, in-app paths are allowed; anything else
 * (absolute URLs, "//host", "/\host", control characters, ...) falls back to "/".
 * Browsers treat "\" like "/" and drop tabs/newlines in URLs, so "/\evil.com" or
 * "/\t/evil.com" would otherwise leave the site (C1 review finding 5).
 */
const BASE = "http://founders.invalid";

export function safeNext(next: unknown): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2000) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  // Backslashes and ASCII control characters (incl. tab/CR/LF) and DEL are never valid here.
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return "/";
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
