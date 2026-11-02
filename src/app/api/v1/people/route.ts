import { NextResponse, type NextRequest } from "next/server";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { createPerson, listPeople } from "@/server/services/people";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/people?q=&companyId=&unitId=&status=active|left|all&limit=
 * Each role carries `salary` only for salary viewers (the key is absent for everyone else).
 */
export async function GET(req: NextRequest) {
  return handleApi(async (ctx) => {
    const filters = Object.fromEntries(req.nextUrl.searchParams);
    return NextResponse.json({ data: await listPeople(ctx, filters, { salaryScope: "api" }) });
  });
}

/**
 * POST /api/v1/people — body: PersonCreateInput (src/lib/people-schemas.ts).
 * `links[].salary` is accepted only from salary viewers (403 otherwise).
 */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    const person = await createPerson(ctx, body as Parameters<typeof createPerson>[1], "api");
    return NextResponse.json({ data: person }, { status: 201 });
  });
}
