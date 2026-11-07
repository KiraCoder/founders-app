import { NextResponse } from "next/server";
import { handleApi } from "@/server/api";
import { clearChat, getChat } from "@/server/assistant/service";

export const dynamic = "force-dynamic";

/** GET /api/v1/assistant — this founder's chat (messages, cards) and whether AI is set up. */
export async function GET() {
  return handleApi(async (ctx) => NextResponse.json({ data: await getChat(ctx) }));
}

/** DELETE /api/v1/assistant — clear this founder's chat (pending cards are cancelled). */
export async function DELETE() {
  return handleApi(async (ctx) => {
    await clearChat(ctx);
    return NextResponse.json({ data: { ok: true } });
  });
}
