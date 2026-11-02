import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/server/auth/session-token";

/** No session cookie needed. The two API routes check their own secrets (constant-time). */
const PUBLIC_PATHS = ["/login", "/api/telegram/webhook", "/api/cron/tick"];

/**
 * First gate: every route except /login needs a validly signed session cookie.
 * Pages are redirected to /login; API routes get a JSON 401.
 * (Session revocation/expiry is re-checked against the DB in getCurrentUser().)
 */
export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
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
