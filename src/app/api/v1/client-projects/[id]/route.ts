import { NextResponse, type NextRequest } from "next/server";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { getClientProject, setClientProjectArchived, updateClientProject } from "@/server/services/client-projects";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const companyOf = (req: NextRequest) => new URL(req.url).searchParams.get("companyId") ?? "";

/** GET /api/v1/client-projects/:id?companyId=… */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => NextResponse.json({ data: await getClientProject(ctx, companyOf(req), id) }));
}

/**
 * PATCH /api/v1/client-projects/:id — `{ companyId, …fields to change }`, or
 * `{ companyId, archived: true | false }` to archive / restore.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    const { companyId: rawCompany, archived, ...rest } = body as Record<string, unknown>;
    const companyId = typeof rawCompany === "string" ? rawCompany : "";
    if (archived !== undefined) {
      if (typeof archived !== "boolean") return jsonError(400, "validation", "archived must be true or false");
      if (Object.keys(rest).length > 0) return jsonError(400, "validation", "Archive or change fields, not both at once");
      return NextResponse.json({ data: await setClientProjectArchived(ctx, companyId, id, archived) });
    }
    return NextResponse.json({ data: await updateClientProject(ctx, companyId, id, rest) });
  });
}

/** DELETE /api/v1/client-projects/:id?companyId=… — archives (never a hard delete). */
export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => NextResponse.json({ data: await setClientProjectArchived(ctx, companyOf(req), id, true) }));
}
