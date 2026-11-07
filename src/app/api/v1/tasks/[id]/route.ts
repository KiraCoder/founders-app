import { NextResponse, type NextRequest } from "next/server";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { deleteTask, getTask, updateTask } from "@/server/services/tasks";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    if (!UUID_RE.test(id)) return jsonError(404, "not_found", "Task not found");
    return NextResponse.json({ data: await getTask(ctx, id) });
  });
}

/** PATCH /api/v1/tasks/:id — body: partial TaskUpdateInput. Deadline changes are audited. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    if (!UUID_RE.test(id)) return jsonError(404, "not_found", "Task not found");
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    return NextResponse.json({ data: await updateTask(ctx, id, body as Parameters<typeof updateTask>[2]) });
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    if (!UUID_RE.test(id)) return jsonError(404, "not_found", "Task not found");
    await deleteTask(ctx, id);
    return new NextResponse(null, { status: 204 });
  });
}
