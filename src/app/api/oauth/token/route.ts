import { getDb } from "@/server/db/client";
import { handleToken, preflight } from "@/server/http/oauth";

export const dynamic = "force-dynamic";

/** POST /api/oauth/token — authorization_code (PKCE) and refresh_token grants. No session; exempt from the middleware. */
export async function POST(req: Request) {
  return handleToken(req, { db: await getDb() });
}

export function OPTIONS() {
  return preflight();
}
