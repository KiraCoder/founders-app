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

/** The founders' bot (@founders_app_bot): invite deep links work even before TELEGRAM_BOT_USERNAME is set. */
export const DEFAULT_BOT_USERNAME = "founders_app_bot";

/** Bot username for "Invite to Telegram" links: TELEGRAM_BOT_USERNAME, else @founders_app_bot. */
export function inviteBotUsername(): string {
  return telegramBotUsername() ?? DEFAULT_BOT_USERNAME;
}

/** https://t.me/<bot>?start=<code> (the code is A-Z/2-9 and one hyphen, valid as a start parameter). */
export function inviteDeepLink(code: string): string {
  return `https://t.me/${inviteBotUsername()}?start=${encodeURIComponent(code)}`;
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
