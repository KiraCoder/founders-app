"use server";

import { revalidatePath } from "next/cache";
import { getPageContext } from "@/server/context";
import { toServiceError } from "@/server/services/errors";
import {
  createPersonInvite,
  setPersonBotEnabled,
  setPersonChase,
  setPersonPause,
  setTaskStaffChase,
  unlinkPerson,
  updateStaffDefaults,
} from "@/server/services/staff";
import { addTaskComment, decideDeadlineRequest, deleteTaskComment, updateTaskComment } from "@/server/services/task-comments";

/** Team on Telegram + task comments: thin server actions over the service layer (founders only there). */
export interface StaffFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  message?: string;
  nonce?: number;
}

async function run(fn: () => Promise<unknown>, message?: string): Promise<StaffFormState> {
  try {
    await fn();
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
  revalidatePath("/", "layout");
  return { ok: true, message, nonce: Date.now() };
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const fields = (fd: FormData, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => fd.has(k)).map((k) => [k, str(fd, k)]));

const SETTING_KEYS = [
  "quietStart",
  "quietEnd",
  "workStart",
  "workEnd",
  "chaseEveryMinutes",
  "maxPerDay",
  "escalateAfterChases",
  "escalateAt",
  "morningList",
  "morningListTime",
] as const;

export interface InviteState {
  code?: string;
  deepLink?: string;
  expiresAt?: string;
  botUsername?: string;
  error?: string;
}

export async function invitePersonAction(personId: string): Promise<InviteState> {
  const ctx = await getPageContext();
  try {
    const inv = await createPersonInvite(ctx, personId);
    revalidatePath("/settings/team-telegram");
    return { code: inv.code, deepLink: inv.deepLink, expiresAt: inv.expiresAt.toISOString(), botUsername: inv.botUsername };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { error: se.message };
  }
}

export async function saveStaffDefaultsAction(_p: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const ctx = await getPageContext();
  const input = { ...fields(fd, SETTING_KEYS), morningList: fd.get("morningList") === "on" };
  return run(() => updateStaffDefaults(ctx, input), "Saved");
}

export async function setPersonBotAction(_p: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const ctx = await getPageContext();
  const on = str(fd, "enabled") === "1";
  return run(() => setPersonBotEnabled(ctx, str(fd, "personId"), on), on ? "Bot may message" : "Switched off");
}

export async function setPersonPauseAction(_p: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const ctx = await getPageContext();
  return run(() => setPersonPause(ctx, str(fd, "personId"), fd.get("resume") ? "" : str(fd, "until")), "Saved");
}

export async function setPersonChaseAction(_p: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const ctx = await getPageContext();
  const input = fields(fd, SETTING_KEYS);
  if (fd.get("clear")) return run(() => setPersonChase(ctx, str(fd, "personId"), {}), "Using the defaults");
  return run(() => setPersonChase(ctx, str(fd, "personId"), input), "Saved");
}

export async function unlinkPersonAction(_p: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const ctx = await getPageContext();
  return run(() => unlinkPerson(ctx, str(fd, "personId")), "Unlinked");
}

export async function setTaskChaseAction(_p: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const ctx = await getPageContext();
  if (fd.get("clear")) return run(() => setTaskStaffChase(ctx, str(fd, "taskId"), {}), "Using the person's settings");
  return run(
    () => setTaskStaffChase(ctx, str(fd, "taskId"), fields(fd, ["chaseEnabled", "chaseEveryMinutes", "escalateAfterChases", "escalateAt"])),
    "Saved",
  );
}

export async function addCommentAction(_p: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const ctx = await getPageContext();
  return run(() => addTaskComment(ctx, str(fd, "taskId"), str(fd, "text")));
}

export async function editCommentAction(_p: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const ctx = await getPageContext();
  return run(() => updateTaskComment(ctx, str(fd, "commentId"), str(fd, "text")));
}

export async function deleteCommentAction(_p: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const ctx = await getPageContext();
  return run(() => deleteTaskComment(ctx, str(fd, "commentId")));
}

export async function decideDeadlineAction(_p: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const ctx = await getPageContext();
  const approve = str(fd, "decision") === "approve";
  return run(() => decideDeadlineRequest(ctx, str(fd, "requestId"), approve), approve ? "Approved" : "Declined");
}
