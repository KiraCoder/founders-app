import type { ChaseFormValue } from "@/lib/task-chase";
import type { TaskPriorityValue, TaskStatusValue } from "@/lib/schemas";

/** Serializable task shape passed from server components to client components. */
export interface TaskItem {
  id: string;
  /** "UPS-1583" / "ME-12". */
  key: string;
  title: string;
  notes: string | null;
  visibility: "private" | "shared";
  status: TaskStatusValue;
  priority: TaskPriorityValue;
  estimate: number | null;
  needsReview: boolean;
  dueDate: string | null;
  ownerUserId: string;
  ownerName: string;
  company: { id: string; slug: string; name: string; color: string } | null;
  project: { id: string; name: string } | null;
  orgDepartment?: { id: string; number: number; name: string } | null;
  assignee: { kind: "user" | "person"; id: string; name: string } | null;
  labels: { id: string; name: string; color: string }[];
  isOverdue: boolean;
  overEstimate: boolean;
  /** ISO timestamps (list "Created" / "Updated" columns). */
  createdAt: string;
  updatedAt: string;
}

/** What the list shows next to a task (services/task-activity.ts, serializable). */
export interface TaskActivityItem {
  comments: number;
  checklist: { done: number; total: number } | null;
  lastSent: { at: string; what: string; status: "sent" | "failed" | "waiting" } | null;
  lastReply: { at: string; what: string } | null;
  reminders: number;
  sentToPerson: boolean;
  chase: ChaseFormValue;
}

type TaskLike = Omit<TaskItem, "createdAt" | "updatedAt" | "labels" | "overEstimate" | "estimate" | "needsReview" | "key"> & {
  key?: string;
  estimate?: number | null;
  needsReview?: boolean;
  overEstimate?: boolean;
  labels?: { id: string; name: string; color: string }[];
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

const iso = (d: Date | string | undefined) => (d instanceof Date ? d.toISOString() : (d ?? new Date(0).toISOString()));

/** Strips server-only fields before handing tasks to client components. */
export function toTaskItem(t: TaskLike): TaskItem {
  return {
    id: t.id,
    key: t.key ?? "",
    title: t.title,
    notes: t.notes,
    visibility: t.visibility,
    status: t.status,
    priority: t.priority,
    estimate: t.estimate ?? null,
    needsReview: t.needsReview ?? true,
    dueDate: t.dueDate,
    ownerUserId: t.ownerUserId,
    ownerName: t.ownerName,
    company: t.company,
    project: t.project,
    orgDepartment: t.orgDepartment ?? null,
    assignee: t.assignee,
    labels: (t.labels ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
    isOverdue: t.isOverdue,
    overEstimate: t.overEstimate ?? false,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}
