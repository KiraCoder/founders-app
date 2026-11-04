import { NextResponse, type NextRequest } from "next/server";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { createClientProject, listClientProjects } from "@/server/services/client-projects";

export const dynamic = "force-dynamic";

/** GET /api/v1/client-projects?companyId=…&archived=1 — a company's client projects (founders only). */
export async function GET(req: NextRequest) {
  return handleApi(async (ctx) => {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId") ?? "";
    return NextResponse.json({ data: await listClientProjects(ctx, companyId, { includeArchived: url.searchParams.get("archived") === "1" }) });
  });
}

/**
 * POST /api/v1/client-projects — `{ companyId, clientName, title, stage?, status?, startDate?,
 * dueDate?, slaMonthlyFee? ("12500.50"), slaCurrency?, slaResponseHours?, nextInvoiceDate?, notes? }`.
 */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    const { companyId, ...rest } = body as Record<string, unknown>;
    return NextResponse.json({ data: await createClientProject(ctx, typeof companyId === "string" ? companyId : "", rest) }, { status: 201 });
  });
}
