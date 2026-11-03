"use server";

import { revalidatePath } from "next/cache";
import { getPageContext } from "@/server/context";
import { toServiceError } from "@/server/services/errors";
import {
  createMyTelegramLinkCode,
  unlinkMyTelegram,
  updateMyPreferences,
} from "@/server/services/notifications";
import type { NotificationPrefsInput } from "@/lib/schemas";
import type { TelegramSetupResult } from "@/server/notifications/telegram-setup";
import type { ReminderClockResult } from "@/server/notifications/reminder-clock";
import { connectTelegramBot, getReminderClockStatus, getTelegramBotStatus, startAppReminderClock } from "@/server/services/app-setup";

export interface PrefsState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  nonce?: number;
}

const PREF_FIELDS = [
  "morningSummaryTime",
  "eveningCheckEnabled",
  "eveningCheckTime",
  "quietStart",
  "quietEnd",
  "maxOtherPerDay",
  "urgentAtNight",
  "overdueChaseStyle",
] as const;

export async function savePreferencesAction(_prev: PrefsState, fd: FormData): Promise<PrefsState> {
  const ctx = await getPageContext();
  const input: Record<string, unknown> = {};
  for (const key of PREF_FIELDS) input[key] = fd.get(key) ?? "";
  try {
    await updateMyPreferences(ctx, input as NotificationPrefsInput);
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
  revalidatePath("/settings");
  return { ok: true, nonce: Date.now() };
}

export interface LinkCodeState {
  code?: string;
  expiresAt?: string;
}

/** The plain code is returned once to the browser and never stored (only its hash). */
export async function createLinkCodeAction(): Promise<LinkCodeState> {
  const ctx = await getPageContext();
  const { code, expiresAt } = await createMyTelegramLinkCode(ctx);
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function unlinkTelegramAction(): Promise<void> {
  const ctx = await getPageContext();
  await unlinkMyTelegram(ctx);
  revalidatePath("/settings");
}

// --- App setup (founders only; the services check) ---------------------------------
export async function connectTelegramAction(): Promise<TelegramSetupResult> {
  const ctx = await getPageContext();
  return connectTelegramBot(ctx);
}

export async function telegramStatusAction(): Promise<TelegramSetupResult> {
  const ctx = await getPageContext();
  return getTelegramBotStatus(ctx);
}

export async function startReminderClockAction(): Promise<ReminderClockResult> {
  const ctx = await getPageContext();
  return startAppReminderClock(ctx);
}

export async function reminderClockStatusAction(): Promise<ReminderClockResult> {
  const ctx = await getPageContext();
  return getReminderClockStatus(ctx);
}
