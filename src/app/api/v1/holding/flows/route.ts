import { NextResponse, type NextRequest } from "next/server";
import type { FlowCreateInput } from "@/lib/holding-schemas";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { createFlow, listFlows } from "@/server/services/holding";

export const dynamic = "force-dynamic";

/** GET /api/v1/holding/flows?archived=1 — intercompany flows (who does what for whom since when). */
export async function GET(req: NextRequest) {
  return handleApi(async (ctx) => {
    const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
    return NextResponse.json({ data: await listFlows(ctx, { includeArchived }) });
  });
}

/** POST /api/v1/holding/flows — `{ fromCompanyId, toCompanyId, service, description?, since?, until?, status? }`. */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    return NextResponse.json({ data: await createFlow(ctx, body as FlowCreateInput) }, { status: 201 });
  });
}
