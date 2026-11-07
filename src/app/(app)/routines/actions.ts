"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { RoutineStatus } from "@/lib/routines";
import { getPageContext } from "@/server/context";
import { toServiceError } from "@/server/services/errors";
import {
  createExampleRoutine,
  createRoutine,
  deleteRoutine,
  runRoutineNow,
  setRoutineStatus,
  updateRoutine,
} from "@/server/services/routines";

/** Routines: thin server actions over services/routines.ts (founders only there). */
export interface RoutineFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  message?: string;
  nonce?: number;
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
    time: str(fd, "time"),
    confirmation: str(fd, "confirmation") || "button",
    items: str(fd, "items"),
    chase: {
      chaseEveryMinutes: str(fd, "chaseEveryMinutes"),
      chaseUntil: str(fd, "chaseUntil"),
      escalateAt: str(fd, "escalateAt"),
      escalateAfterChases: str(fd, "escalateAfterChases"),
      maxPerDay: str(fd, "maxPerDay"),
    },
  };
}

async function run(fn: () => Promise<unknown>, message?: string): Promise<RoutineFormState> {
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

export async function createRoutineAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  let id: string | null = null;
  const state = await run(async () => {
    id = (await createRoutine(ctx, formInput(fd))).id;
  });
  if (id) redirect(`/routines/${id}`);
  return state;
}

export async function updateRoutineAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  return run(() => updateRoutine(ctx, str(fd, "id"), formInput(fd)), "Saved");
}

export async function setRoutineStatusAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  const status = str(fd, "status") as RoutineStatus;
  const label = status === "paused" ? "Paused" : status === "archived" ? "Archived" : "Active again";
  return run(() => setRoutineStatus(ctx, str(fd, "id"), status), label);
}

export async function runRoutineNowAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  return run(() => runRoutineNow(ctx, str(fd, "id")), "Asked now: the message goes out with the next tick");
}

export async function deleteRoutineAction(_p: RoutineFormState, fd: FormData): Promise<RoutineFormState> {
  const ctx = await getPageContext();
  const state = await run(() => deleteRoutine(ctx, str(fd, "id")));
  if (state.ok) redirect("/routines");
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
