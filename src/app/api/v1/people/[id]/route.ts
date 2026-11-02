import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { linkCreateSchema, linkUpdateSchema, personUpdateSchema, salaryInputSchema } from "@/lib/people-schemas";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { assertSalaryViewer } from "@/server/services/access";
import {
  addPersonLink,
  addPersonSalary,
  getPerson,
  updatePerson,
  updatePersonLink,
} from "@/server/services/people";
import { ServiceError } from "@/server/services/errors";

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

const patchSchema = z
  .object({
    person: personUpdateSchema.optional(),
    addLinks: z.array(linkCreateSchema).max(20).optional(),
    updateLinks: z.array(z.object({ id: z.uuid(), changes: linkUpdateSchema }).strict()).max(20).optional(),
    /** Salary viewers only: new salary rows (history is kept). */
    addSalaries: z.array(z.object({ linkId: z.uuid(), salary: salaryInputSchema }).strict()).max(20).optional(),
  })
  .strict();

/**
 * PATCH /api/v1/people/:id
 * Body: either person fields directly (PersonUpdateInput, e.g. `{ "status": "left" }`), or
 * `{ person?, addLinks?, updateLinks?, addSalaries? }`. Salary changes need a salary viewer (403).
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
    const input = patchSchema.parse(structured ? body : { person: body });

    // Refuse salary writes up front, before anything else is changed.
    if (input.addSalaries?.length || input.addLinks?.some((l) => l.salary)) await assertSalaryViewer(ctx);

    let person = await getPerson(ctx, id);
    if (input.person) person = await updatePerson(ctx, id, input.person);
    for (const l of input.addLinks ?? []) person = await addPersonLink(ctx, id, l, "api");
    for (const u of input.updateLinks ?? []) {
      if (!person.roles.some((r) => r.id === u.id)) throw new ServiceError("not_found", "Company link not found");
      person = await updatePersonLink(ctx, u.id, u.changes);
    }
    for (const s of input.addSalaries ?? []) {
      if (!person.roles.some((r) => r.id === s.linkId)) throw new ServiceError("not_found", "Company link not found");
      person = await addPersonSalary(ctx, s.linkId, s.salary, "api");
    }
    return NextResponse.json({ data: await getPerson(ctx, id, { salaryScope: "api" }) });
  });
}
