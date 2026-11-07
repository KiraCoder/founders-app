import { getDb } from "@/server/db/client";
import { handleRevoke, preflight } from "@/server/http/oauth";

export const dynamic = "force-dynamic";

/** POST /api/oauth/revoke — token revocation (RFC 7009). No session; exempt from the middleware. */
export async function POST(req: Request) {
  return handleRevoke(req, { db: await getDb() });
}

export function OPTIONS() {
  return preflight();
}
