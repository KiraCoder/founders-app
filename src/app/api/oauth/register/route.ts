import { getDb } from "@/server/db/client";
import { handleRegister, preflight } from "@/server/http/oauth";

export const dynamic = "force-dynamic";

/** POST /api/oauth/register — dynamic client registration (RFC 7591). No session; exempt from the middleware. */
export async function POST(req: Request) {
  return handleRegister(req, { db: await getDb() });
}

export function OPTIONS() {
  return preflight();
}
