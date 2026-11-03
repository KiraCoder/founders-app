import { NextResponse, type NextRequest } from "next/server";
import type { HireCreateInput } from "@/lib/ai-roles";
import { providerStatus } from "@/server/ai/provider";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { hireRole, listHires, listTemplates } from "@/server/services/ai-roles";
import { assertAiRolesAccess } from "@/server/services/access";

export const dynamic = "force-dynamic";

/** GET /api/v1/ai/roles — the role catalogue (templates), the hires (optionally `?companyId=`) and the AI provider status. */
export async function GET(req: NextRequest) {
  return handleApi(async (ctx) => {
    assertAiRolesAccess(ctx);
    const companyId = req.nextUrl.searchParams.get("companyId") || undefined;
    const { id, configured } = providerStatus();
    return NextResponse.json({
      data: { templates: listTemplates(), hires: await listHires(ctx, { companyId }), provider: { id, configured } },
    });
  });
}

/** POST /api/v1/ai/roles — hire a role: `{ templateKey, companyId, settings?, notes? }` (201). */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    return NextResponse.json({ data: await hireRole(ctx, body as HireCreateInput) }, { status: 201 });
  });
}
