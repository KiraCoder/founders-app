import { NextResponse, type NextRequest } from "next/server";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { sendMessage } from "@/server/assistant/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/v1/assistant/messages — body {text}. Returns the new messages (reply, preview cards). */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || typeof (body as { text?: unknown }).text !== "string") {
      return jsonError(400, "validation", "Body must be {\"text\": \"...\"}");
    }
    // Links in answers are relative (the panel is inside the app).
    return NextResponse.json({ data: await sendMessage(ctx, (body as { text: string }).text, { baseUrl: "" }) });
  });
}
