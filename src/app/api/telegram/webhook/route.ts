import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { devToolsEnabled, telegramBotToken, telegramWebhookSecret } from "@/server/notifications/config";
import { safeEqual } from "@/server/notifications/secrets";
import { executeBotActions, handleTelegramUpdate } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";

export const dynamic = "force-dynamic";

/**
 * Telegram webhook. Telegram sends the secret we registered with setWebhook in the
 * X-Telegram-Bot-Api-Secret-Token header; anything else gets 401 (constant-time compare).
 * Also used by `npm run telegram:poll`, which forwards getUpdates results here.
 */
export async function POST(req: Request): Promise<Response> {
  const expected = telegramWebhookSecret();
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token"), expected)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  try {
    const actions = await handleTelegramUpdate(await getDb(), update, new Date());
    const token = telegramBotToken();
    if (token) await executeBotActions(actions, token);
    // Only with dev tools on and no token (local/e2e) are the replies returned for
    // inspection; otherwise bot replies never appear in the HTTP response.
    return NextResponse.json(devToolsEnabled() && !token ? { ok: true, actions } : { ok: true });
  } catch (err) {
    console.error("[telegram] update failed", err);
    // 200 so Telegram does not retry the same broken update forever.
    return NextResponse.json({ ok: false });
  }
}
