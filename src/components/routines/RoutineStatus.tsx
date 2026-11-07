"use client";

import { createContext, useContext, useOptimistic, type ReactNode } from "react";
import { Tag } from "@/components/ui";
import { STATUS_LABEL, STATUS_TONE } from "./status";

interface RoutineStatusState {
  status: string;
  /** Shows a new status until the action's transition ends (call inside a transition). */
  setStatus: (status: string) => void;
}

const Ctx = createContext<RoutineStatusState | null>(null);

/**
 * A routine's status with pending Pause / Resume / Archive / Restore applied (`useOptimistic`), for
 * everything inside: the status tag and the action buttons switch at once; a failed action rolls
 * back to the server's status (with a toast from the action).
 */
export function RoutineStatusScope({ status, children }: { status: string; children: ReactNode }) {
  const [shown, setStatus] = useOptimistic(status, (_current, next: string) => next);
  return <Ctx.Provider value={{ status: shown, setStatus }}>{children}</Ctx.Provider>;
}

/** The scope's status, or (no scope) this component's own optimistic status. */
export function useRoutineStatus(status: string): RoutineStatusState {
  const scope = useContext(Ctx);
  const [shown, setStatus] = useOptimistic(status, (_current, next: string) => next);
  return scope ?? { status: shown, setStatus };
}

export function RoutineStatusTag({ status }: { status: string }) {
  const shown = useRoutineStatus(status).status;
  return <Tag tone={STATUS_TONE[shown]}>{STATUS_LABEL[shown] ?? shown}</Tag>;
}
