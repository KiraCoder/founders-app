import "server-only";

/** Environment for the notification layer. Read lazily so tests can change process.env. */

export function telegramBotToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

export function telegramWebhookSecret(): string | null {
  return process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
}

export function telegramBotUsername(): string | null {
  return process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || null;
}

export function cronSecret(): string | null {
  return process.env.CRON_SECRET?.trim() || null;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Developer tools (/dev/notifications, simulated ticks). On in development; in a
 * production build only when DEV_TOOLS=1 (e.g. a preview deployment or the e2e run).
 * Never set DEV_TOOLS on the real production site.
 */
export function devToolsEnabled(): boolean {
  return !isProduction() || process.env.DEV_TOOLS === "1";
}
