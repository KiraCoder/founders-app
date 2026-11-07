/**
 * Local Telegram bot without a public URL: long-polls getUpdates and forwards every
 * update to the app's own webhook route (same handler, same secret check).
 *
 *   npm run dev            # terminal 1
 *   npm run telegram:poll  # terminal 2
 *
 * Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env.local. Telegram refuses
 * getUpdates while a webhook is registered for the bot; use a separate test bot locally
 * (or remove the webhook with deleteWebhook, which stops the deployed bot).
 */
import "./env";

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

interface Update {
  update_id: number;
}

async function main() {
  if (!token || !secret) {
    console.error("[telegram:poll] Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env.local first.");
    process.exit(1);
  }
  console.log(`[telegram:poll] polling Telegram, forwarding to ${appUrl}/api/telegram/webhook (Ctrl+C to stop)`);
  let offset = 0;
  for (;;) {
    let updates: Update[] = [];
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["message", "callback_query"] }),
      });
      const body = (await res.json()) as { ok: boolean; result?: Update[]; description?: string; error_code?: number };
      if (!body.ok) {
        console.error(`[telegram:poll] getUpdates failed: ${body.description ?? res.status}`);
        if (body.error_code === 409) console.error("  A webhook is set for this bot. Use a separate dev bot for polling.");
        if (body.error_code === 401) process.exit(1);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      updates = body.result ?? [];
    } catch (err) {
      console.error("[telegram:poll] network error:", err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        const res = await fetch(`${appUrl}/api/telegram/webhook`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
          body: JSON.stringify(update),
        });
        console.log(`[telegram:poll] update ${update.update_id} -> ${res.status}`);
      } catch (err) {
        console.error(`[telegram:poll] could not reach the app at ${appUrl}:`, err instanceof Error ? err.message : err);
      }
    }
  }
}

void main();
