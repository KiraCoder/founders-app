import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/server/auth/session-token";
import { checkMutatingApiRequest } from "@/server/http/request-guard";

/**
 * No session cookie needed. These API routes check their own secrets (constant-time) — the
 * ingest route a browser extension key (Bearer), and it answers its own CORS preflight, so it
 * is exempt from the same-origin guard below too.
 */
const PUBLIC_PATHS = ["/login", "/api/telegram/webhook", "/api/cron/tick", "/api/health"];
/**
 * Public on these exact paths only (nothing below them is exempt). The Claude connector
 * (src/server/http/mcp.ts, src/server/http/oauth.ts): /api/mcp checks its own OAuth bearer
 * token; register / token / revoke authenticate the OAuth client themselves. The consent POST
 * (/api/oauth/authorize) and page (/oauth/authorize) are NOT here: they need the founder's session.
 */
const PUBLIC_EXACT = new Set(["/api/v1/ingest", "/api/mcp", "/api/oauth/register", "/api/oauth/token", "/api/oauth/revoke"]);
/** OAuth / MCP discovery documents (RFC 8414, RFC 9728): public metadata, no data. */
const WELL_KNOWN_PREFIX = "/.well-known/";

/**
 * First gate: every route except /login needs a validly signed session cookie.
 * Pages are redirected to /login; API routes get a JSON 401. Mutating /api/v1 calls
 * must also pass the same-origin + JSON check (src/server/http/request-guard.ts).
 * (Session revocation/expiry is re-checked against the DB in getCurrentUser().)
 */
export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (
    PUBLIC_EXACT.has(pathname) ||
    pathname.startsWith(WELL_KNOWN_PREFIX) ||
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return NextResponse.next();
  }
  // CSRF: mutating REST calls must come from this site and carry JSON.
  if (pathname.startsWith("/api/v1/") || pathname === "/api/v1") {
    const guard = checkMutatingApiRequest(req);
    if (!guard.ok) {
      return NextResponse.json({ error: { code: guard.code, message: guard.message } }, { status: guard.status });
    }
  }
  const claims = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (claims) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in required" } },
      { status: 401 },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
};
