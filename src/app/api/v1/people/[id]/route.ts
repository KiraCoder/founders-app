import { NextResponse, type NextRequest } from "next/server";
import type { PersonPatchInput } from "@/lib/people-schemas";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { getPerson, patchPerson } from "@/server/services/people";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/v1/people/:id — with salary + history per role for salary viewers only. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    if (!UUID_RE.test(id)) return jsonError(404, "not_found", "Person not found");
    return NextResponse.json({ data: await getPerson(ctx, id, { salaryScope: "api" }) });
  });
}

/**
 * PATCH /api/v1/people/:id
 * Body: either person fields directly (PersonUpdateInput, e.g. `{ "status": "left" }`), or
 * `{ person?, addLinks?, updateLinks?, addSalaries? }`. Salary changes need a salary viewer (403).
 * The whole request is one transaction: if any part fails, nothing is changed.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    if (!UUID_RE.test(id)) return jsonError(404, "not_found", "Person not found");
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    const structured = ["person", "addLinks", "updateLinks", "addSalaries"].some((k) => k in body);
    // All or nothing: the service checks everything first and writes in one transaction.
    const data = await patchPerson(ctx, id, (structured ? body : { person: body }) as PersonPatchInput);
    return NextResponse.json({ data });
  });
}
