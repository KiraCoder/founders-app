import "server-only";
import { connectTelegram, telegramSetupConfig, telegramWebhookStatus, type TelegramSetupConfig, type TelegramSetupResult } from "@/server/notifications/telegram-setup";
import { reminderClockConfig, reminderClockStatus, startReminderClock, type ReminderClockConfig, type ReminderClockResult } from "@/server/notifications/reminder-clock";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";

/**
 * One-time setup buttons on Settings (Connect Telegram, Start reminder clock). Founders only:
 * they change how the whole app is reached, not one person's preferences.
 */
export function canSetUpApp(ctx: ServiceContext): boolean {
  return ctx.user.role === "founder";
}

export function assertAppSetupAccess(ctx: ServiceContext): void {
  if (!canSetUpApp(ctx)) throw new ServiceError("forbidden", "Only the founders can set up the app");
}

export function getTelegramSetupConfig(ctx: ServiceContext): TelegramSetupConfig {
  assertAppSetupAccess(ctx);
  return telegramSetupConfig();
}

export async function connectTelegramBot(ctx: ServiceContext): Promise<TelegramSetupResult> {
  assertAppSetupAccess(ctx);
  return connectTelegram();
}

export async function getTelegramBotStatus(ctx: ServiceContext): Promise<TelegramSetupResult> {
  assertAppSetupAccess(ctx);
  return telegramWebhookStatus();
}

export function getReminderClockConfig(ctx: ServiceContext): ReminderClockConfig {
  assertAppSetupAccess(ctx);
  return reminderClockConfig();
}

export async function startAppReminderClock(ctx: ServiceContext): Promise<ReminderClockResult> {
  assertAppSetupAccess(ctx);
  return startReminderClock(ctx.db);
}

export async function getReminderClockStatus(ctx: ServiceContext): Promise<ReminderClockResult> {
  assertAppSetupAccess(ctx);
  return reminderClockStatus(ctx.db);
}
