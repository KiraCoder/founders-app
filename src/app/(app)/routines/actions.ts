"use server";

import { CACHE_TAGS, refreshAfterWrite } from "@/server/cache";
import { redirect } from "next/navigation";
import type { RoutineStatus } from "@/lib/routines";
import { getPageContext } from "@/server/context";
import { dispatch } from "@/server/notifications/dispatcher";
import { toServiceError } from "@/server/services/errors";
import {
  createExampleRoutine,
  createRoutine,
  deleteRoutine,
  rerunRoutineToday,
  runRoutineNow,
  setRoutineAssignee,
  setRoutineStatus,
  updateRoutine,
  updateRoutineChecklist,
  type TodayEffect,
} from "@/server/services/routines";

/** Routines: thin server actions over services/routines.ts (founders only there). */
export interface RoutineFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  message?: string;
  nonce?: number;
  /** The routine created / saved. */
  id?: string;
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

function formInput(fd: FormData) {
  return {
    title: str(fd, "title"),
    description: str(fd, "description"),
    companyId: str(fd, "companyId"),
    assignee: str(fd, "assignee"),
    scheduleKind: str(fd, "scheduleKind") || "weekly",
    days: fd.getAll("days").map(String),
    monthDay: str(fd, "monthDay"),
    times: fd.getAll("times").map(String).filter(Boolean),
    time: str(fd, "time"),
    startsOn: str(fd, "startsOn"),
    endsOn: str(fd, "endsOn"),
    confirmation: str(fd, "confirmation") || "button",
    items: str(fd, "items"),
    applyToToday: str(fd, "applyToToday"),
    chase: {
      reminderMode: str(fd, "reminderMode"),
      remindTimes: str(fd, "remindTimes"),
      chaseEveryMinutes: str(fd, "chaseEveryMinutes"),
      chaseUntil: str(fd, "chaseUntil"),
      escalateAt: str(fd, "escalateAt"),
      escalateAfterChases: str(fd, "escalateAfterChases"),
      escalateTo: fd.getAll("escalateTo").map(String).filter(Boolean),
      maxPerDay: str(fd, "maxPerDay"),
    },
  };
}

async function run(fn: () => Promise<unknown>, message?: string | (() => string)): Promise<RoutineFormState> {
  try {
    await fn();
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields, nonce: Date.now() };
  }
  refreshAfterWrite(CACHE_TAGS.routines);
  return { ok: true, message: typeof message === "function" ? message() : message, nonce: Date.now() };
}

/** Sends what was just queued right away instead of waiting for the next reminder-clock tick (failures stay queued). */
async function sendNow(ctx: Awaited<ReturnType<typeof getPageContext>>) {
  await dispatch(ctx.db, new Date(), { limit: 25 }).catch((err: unknown) => console.error("[routines] immediate send failed", err));
}

export async function createRoutineAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  let id: string | undefined;
  const state = await run(async () => {
    id = (await createRoutine(ctx, formInput(fd))).id;
  }, "Routine created");
  return { ...state, id };
}

const EFFECT_TEXT: Record<Exclude<TodayEffect, null>, string> = {
  open_run_updated: "Saved. Today's open run was updated and the person gets one updated message.",
  reopened: "Saved. Today's run is open again with the new items, and the person was asked.",
  next_run: "Saved. Today's run is already closed, so the change applies from the next run.",
};

export async function updateRoutineAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  let effect: TodayEffect = null;
  const state = await run(
    async () => {
      effect = (await updateRoutine(ctx, str(fd, "id"), formInput(fd))).todayEffect;
      if (effect === "open_run_updated" || effect === "reopened") await sendNow(ctx);
    },
    () => (effect ? EFFECT_TEXT[effect] : "Saved"),
  );
  return { ...state, id: str(fd, "id") };
}

/** The routine page's checklist card: only the items (`items` JSON, `applyToToday`). */
export async function saveRoutineChecklistAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  let effect: TodayEffect = null;
  const state = await run(
    async () => {
      effect = (await updateRoutineChecklist(ctx, str(fd, "id"), str(fd, "items"), { applyToToday: str(fd, "applyToToday") === "1" })).todayEffect;
      if (effect === "open_run_updated" || effect === "reopened") await sendNow(ctx);
    },
    () => (effect ? EFFECT_TEXT[effect] : "Checklist saved"),
  );
  return { ...state, id: str(fd, "id") };
}

export async function setRoutineStatusAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  const status = str(fd, "status") as RoutineStatus;
  const label = status === "paused" ? "Paused" : status === "archived" ? "Archived" : "Active again";
  return run(() => setRoutineStatus(ctx, str(fd, "id"), status), label);
}

export async function runRoutineNowAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  return run(async () => {
    await runRoutineNow(ctx, str(fd, "id"));
    await sendNow(ctx);
  }, "Asked now: sent to Telegram");
}

export async function rerunRoutineAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  return run(async () => {
    await rerunRoutineToday(ctx, str(fd, "id"));
    await sendNow(ctx);
  }, "Asked again about today's missing items");
}

export async function deleteRoutineAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  const state = await run(() => deleteRoutine(ctx, str(fd, "id")), "Deleted");
  if (state.ok && str(fd, "redirect") === "1") redirect("/routines");
  return state;
}

export async function createExampleRoutineAction(): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  let id: string | null = null;
  const state = await run(async () => {
    id = (await createExampleRoutine(ctx)).id;
  });
  if (id) redirect(`/routines/${id}`);
  return state;
}

/** The list's inline status menu (0034): Active / Paused / Archived (Ended follows "Ends on"). */
export async function setRoutineStatusInlineAction(id: string, status: RoutineStatus): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  const label = status === "paused" ? "Paused" : status === "archived" ? "Archived" : "Active again";
  return run(() => setRoutineStatus(ctx, id, status), label);
}

/** The list's inline assignee menu (0034). */
export async function setRoutineAssigneeAction(id: string, assignee: string): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  return run(() => setRoutineAssignee(ctx, id, assignee), "Assignee changed");
}
