import { NextResponse, type NextRequest } from "next/server";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { createTask, listTasks } from "@/server/services/tasks";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/tasks?view=my|assigned|company|overdue&companyId=&projectId=&status=&priority=&q=&limit=
 */
export async function GET(req: NextRequest) {
  return handleApi(async (ctx) => {
    const filters = Object.fromEntries(req.nextUrl.searchParams);
    return NextResponse.json({ data: await listTasks(ctx, filters) });
  });
}

/** POST /api/v1/tasks — body: TaskCreateInput (see src/lib/schemas.ts). */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    const task = await createTask(ctx, body as Parameters<typeof createTask>[1]);
    return NextResponse.json({ data: task }, { status: 201 });
  });
}
