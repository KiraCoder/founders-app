import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { handleAuthorizePost } from "@/server/http/oauth";

export const dynamic = "force-dynamic";

/**
 * POST /api/oauth/authorize — the consent screen's Allow / Cancel (src/app/oauth/authorize).
 * Needs the founder's session (NOT exempt from the middleware), a same-origin request and the
 * form's consent token.
 */
export async function POST(req: Request) {
  return handleAuthorizePost(req, { db: await getDb(), user: await getCurrentUser() });
}
