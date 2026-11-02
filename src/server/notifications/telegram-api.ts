import "server-only";

/**
 * Minimal Telegram Bot API client over fetch. Never logs the token.
 * Tests replace global fetch; nothing here talks to Telegram unless a token is set.
 */
export interface TelegramResult<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** A Bot API call that has not answered after this long is abandoned (and retried later). */
export const TELEGRAM_TIMEOUT_MS = 10_000;

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.telegram.org",
  ) {}

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = TELEGRAM_TIMEOUT_MS,
  ): Promise<TelegramResult<T>> {
    try {
      const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        // Never let a hung request keep a dispatch run (and its claimed items) waiting.
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json().catch(() => null)) as TelegramResult<T> | null;
      if (body && typeof body.ok === "boolean") return body;
      return { ok: false, error_code: res.status, description: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, description: `network: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  sendMessage(params: Record<string, unknown>) {
    return this.call<{ message_id: number }>("sendMessage", params);
  }
  editMessageText(params: Record<string, unknown>) {
    return this.call("editMessageText", params);
  }
  answerCallbackQuery(params: Record<string, unknown>) {
    return this.call("answerCallbackQuery", params);
  }
  getUpdates(params: Record<string, unknown>) {
    // Long polling: allow the server-side wait plus the normal timeout.
    const wait = typeof params.timeout === "number" ? params.timeout * 1000 : 0;
    return this.call<TelegramUpdate[]>("getUpdates", params, wait + TELEGRAM_TIMEOUT_MS);
  }
}

// --- Update shapes (only the fields we use) ---------------------------------
export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}
export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
