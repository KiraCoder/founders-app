import { getDb } from "@/server/db/client";
import { handleIngestPreflight, handleIngestRequest } from "@/server/http/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/v1/ingest — numbers from the founders' Chrome extension (Bearer personal key;
 * contract in the README, "Browser extension"). OPTIONS answers the CORS preflight for
 * chrome-extension:// origins only. Exempt from the session / same-origin middleware.
 */
export async function POST(req: Request) {
  return handleIngestRequest(req, { db: await getDb() });
}

export function OPTIONS(req: Request) {
  return handleIngestPreflight(req);
}
