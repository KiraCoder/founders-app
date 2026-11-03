import "server-only";
import { resolveAppBaseUrl, type AppUrlSource } from "@/server/app-url";
import { TelegramApi } from "./telegram-api";

/**
 * Settings → "Connect Telegram" (founders only): tells Telegram where to deliver the bot's
 * updates (setWebhook with our secret), sets the bot's command menu (setMyCommands) and
 * reads back getWebhookInfo. Replaces the curl commands of the old README. Never returns or
 * logs the token or the secret.
 */

type Env = Record<string, string | undefined>;

export const WEBHOOK_PATH = "/api/telegram/webhook";
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;
export const BOT_COMMANDS = [
  { command: "today", description: "Today: overdue, due today, waiting" },
  { command: "tasks", description: "My open tasks" },
  { command: "help", description: "What the bot can do" },
] as const;

/** Telegram's rule for secret_token: 1–256 characters, A–Z, a–z, 0–9, _ and -. */
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

export interface TelegramSetupConfig {
  /** Variables still missing, by name (APP_URL counts as present when Vercel gives a URL). */
  missing: string[];
  /** Set but unusable (e.g. a secret with characters Telegram refuses). */
  problems: string[];
  appUrl: string | null;
  appUrlSource: AppUrlSource | null;
  /** The webhook address Telegram will be given. */
  webhookUrl: string | null;
}

export function telegramSetupConfig(env: Env = process.env): TelegramSetupConfig {
  const base = resolveAppBaseUrl(env);
  const missing: string[] = [];
  const problems: string[] = [];
  if (!base) missing.push("APP_URL");
  if (!env.TELEGRAM_BOT_TOKEN?.trim()) missing.push("TELEGRAM_BOT_TOKEN");
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) missing.push("TELEGRAM_WEBHOOK_SECRET");
  else if (!SECRET_RE.test(secret)) {
    problems.push("TELEGRAM_WEBHOOK_SECRET may only contain letters, digits, _ and - (up to 256): make a new one with `openssl rand -hex 32`.");
  }
  if (base && !base.url.startsWith("https://")) {
    problems.push(`Telegram only delivers to an https:// address; the app URL is ${base.url}.`);
  }
  return {
    missing,
    problems,
    appUrl: base?.url ?? null,
    appUrlSource: base?.source ?? null,
    webhookUrl: base ? `${base.url}${WEBHOOK_PATH}` : null,
  };
}

export interface WebhookStatus {
  /** The URL Telegram delivers to ("" = no webhook). */
  url: string;
  /** True when that is this app's webhook address. */
  matchesThisApp: boolean;
  pendingUpdateCount: number;
  lastErrorMessage: string | null;
  /** ISO time of the last delivery error. */
  lastErrorAt: string | null;
}

export type TelegramSetupResult =
  | { ok: false; step: "config"; config: TelegramSetupConfig; message: string }
  | { ok: false; step: "setWebhook" | "setMyCommands" | "getWebhookInfo"; config: TelegramSetupConfig; message: string; status?: WebhookStatus }
  | { ok: true; config: TelegramSetupConfig; status: WebhookStatus; message: string };

interface RawWebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
}

function toStatus(info: RawWebhookInfo, config: TelegramSetupConfig): WebhookStatus {
  const url = info.url ?? "";
  return {
    url,
    matchesThisApp: !!config.webhookUrl && url === config.webhookUrl,
    pendingUpdateCount: info.pending_update_count ?? 0,
    lastErrorMessage: info.last_error_message ?? null,
    lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
  };
}

function configBlocked(config: TelegramSetupConfig): string | null {
  if (config.missing.length) return `Missing in Vercel → Settings → Environment Variables: ${config.missing.join(", ")}. Add them, redeploy, then press Connect again.`;
  if (config.problems.length) return config.problems.join(" ");
  return null;
}

/** getWebhookInfo only (Check status). Needs the bot token. */
export async function telegramWebhookStatus(env: Env = process.env, api?: TelegramApi): Promise<TelegramSetupResult> {
  const config = telegramSetupConfig(env);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { ok: false, step: "config", config, message: "TELEGRAM_BOT_TOKEN is not set, so the bot's status can't be read." };
  const res = await (api ?? new TelegramApi(token)).call<RawWebhookInfo>("getWebhookInfo");
  if (!res.ok || !res.result) return { ok: false, step: "getWebhookInfo", config, message: `Telegram did not answer: ${res.description ?? "unknown error"}` };
  const status = toStatus(res.result, config);
  return { ok: true, config, status, message: status.url ? (status.matchesThisApp ? "Connected to this app." : "The bot delivers somewhere else.") : "Not connected yet." };
}

/** setWebhook + setMyCommands + getWebhookInfo. Safe to press again (Telegram replaces the webhook). */
export async function connectTelegram(env: Env = process.env, api?: TelegramApi): Promise<TelegramSetupResult> {
  const config = telegramSetupConfig(env);
  const blocked = configBlocked(config);
  if (blocked) return { ok: false, step: "config", config, message: blocked };
  const client = api ?? new TelegramApi(env.TELEGRAM_BOT_TOKEN!.trim());

  const hook = await client.call("setWebhook", {
    url: config.webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET!.trim(),
    allowed_updates: [...ALLOWED_UPDATES],
  });
  if (!hook.ok) {
    const hint = hook.error_code === 401 || hook.error_code === 404 ? " (check TELEGRAM_BOT_TOKEN)" : "";
    return { ok: false, step: "setWebhook", config, message: `Telegram refused the webhook: ${hook.description ?? "unknown error"}${hint}` };
  }
  const commands = await client.call("setMyCommands", { commands: BOT_COMMANDS.map((c) => ({ ...c })) });
  const info = await client.call<RawWebhookInfo>("getWebhookInfo");
  const status = info.ok && info.result ? toStatus(info.result, config) : undefined;
  if (!commands.ok) {
    return { ok: false, step: "setMyCommands", config, status, message: `Webhook set, but the command menu was refused: ${commands.description ?? "unknown error"}. Press Connect again.` };
  }
  if (!status) return { ok: false, step: "getWebhookInfo", config, message: `Webhook and commands set, but the status could not be read: ${info.description ?? "unknown error"}` };
  return { ok: true, config, status, message: "Connected: Telegram now delivers to this app. Each founder links with /start CODE (below)." };
}
