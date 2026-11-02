import "server-only";
import { telegramBotToken } from "./config";
import { renderTelegram } from "./render-telegram";
import { TelegramApi } from "./telegram-api";
import type { ActionCallbacks, ChannelName, NeutralMessage, NotificationChannel, Recipient, SendResult } from "./types";

/** Sends through the Telegram Bot API (HTML parse mode + inline keyboard). */
export class TelegramChannel implements NotificationChannel {
  readonly name = "telegram" as const;
  constructor(private readonly api: TelegramApi) {}

  async send(recipient: Recipient, message: NeutralMessage, callbacks?: ActionCallbacks): Promise<SendResult> {
    if (!recipient.telegramChatId) return { ok: false, error: "not_linked", permanent: true };
    const res = await this.api.sendMessage({
      chat_id: recipient.telegramChatId,
      ...renderTelegram(message, callbacks),
      link_preview_options: { is_disabled: true },
    });
    if (res.ok) {
      const id = (res.result as { message_id?: number } | undefined)?.message_id;
      return { ok: true, providerMessageId: id !== undefined ? String(id) : undefined };
    }
    // 400/403: bad chat or the founder blocked the bot -> retrying will not help.
    const permanent = res.error_code === 400 || res.error_code === 403;
    return { ok: false, error: res.description ?? "telegram error", permanent };
  }
}

/**
 * Used when no TELEGRAM_BOT_TOKEN is set (local dev, tests, e2e) or the founder has not
 * linked Telegram yet. "Delivers" by keeping the message in the outbox row, which the
 * dev inbox (/dev/notifications) shows. Never leaves the server.
 */
export class DevChannel implements NotificationChannel {
  readonly name = "dev" as const;
  async send(recipient: Recipient): Promise<SendResult> {
    return { ok: true, providerMessageId: `dev-${recipient.userId.slice(0, 8)}-${Date.now()}` };
  }
}

/** Placeholder so the iOS app can plug in later (APNs). Not registered yet. */
export interface PushChannel extends NotificationChannel {
  readonly name: "push";
}

export interface ChannelRegistry {
  get(name: ChannelName): NotificationChannel | undefined;
  /** Which channel a recipient gets right now. */
  resolve(recipient: Recipient): NotificationChannel;
}

/**
 * Default registry: Telegram when a token is configured AND the founder linked a chat,
 * otherwise the dev inbox. Push will slot in here (e.g. prefer push when a device token exists).
 */
export function createChannelRegistry(opts: { telegramToken?: string | null } = {}): ChannelRegistry {
  const token = opts.telegramToken === undefined ? telegramBotToken() : opts.telegramToken;
  const dev = new DevChannel();
  const telegram = token ? new TelegramChannel(new TelegramApi(token)) : null;
  const channels = new Map<ChannelName, NotificationChannel>([["dev", dev]]);
  if (telegram) channels.set("telegram", telegram);
  return {
    get: (name) => channels.get(name),
    resolve: (r) => (telegram && r.telegramChatId ? telegram : dev),
  };
}
