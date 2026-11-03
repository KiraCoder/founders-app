import { NextResponse, type NextRequest } from "next/server";
import { handleApi } from "@/server/api";
import { getRun } from "@/server/services/ai-roles";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/ai/runs/:id — one report: status, missing numbers, findings, numbers used, narrative status. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => NextResponse.json({ data: await getRun(ctx, id) }));
}
