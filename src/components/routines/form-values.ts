/** Routine form values and options (shared by the server pages and the client form; not a client module). */
import type { RoutineChase, RoutineChaseOverride } from "@/lib/routines";

export interface RoutineFormValues {
  id?: string;
  title: string;
  description: string;
  companyId: string;
  assignee: string;
  scheduleKind: "weekly" | "monthly";
  days: number[];
  monthDay: string;
  time: string;
  confirmation: "button" | "checklist";
  items: string;
  chase: RoutineChaseOverride;
}

export interface RoutineFormOptions {
  founders: { id: string; name: string }[];
  people: { id: string; name: string }[];
  companies: { id: string; name: string }[];
  /** What a blank chase field means (the person's settings or the global staff defaults). */
  defaults: RoutineChase;
}

export const EMPTY_ROUTINE: RoutineFormValues = {
  title: "",
  description: "",
  companyId: "",
  assignee: "",
  scheduleKind: "weekly",
  days: [1, 2, 3, 4, 5],
  monthDay: "",
  time: "10:00",
  confirmation: "button",
  items: "",
  chase: {},
};

