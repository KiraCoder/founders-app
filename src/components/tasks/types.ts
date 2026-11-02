/** Serializable task shape passed from server components to client components. */
export interface TaskItem {
  id: string;
  title: string;
  notes: string | null;
  visibility: "private" | "shared";
  status: "todo" | "in_progress" | "waiting" | "done" | "cancelled";
  priority: "urgent" | "high" | "normal" | "low";
  dueDate: string | null;
  ownerUserId: string;
  ownerName: string;
  company: { id: string; slug: string; name: string; color: string } | null;
  project: { id: string; name: string } | null;
  assignee: { kind: "user" | "person"; id: string; name: string } | null;
  isOverdue: boolean;
}

/** Strips server-only fields (timestamps) before handing tasks to client components. */
export function toTaskItem<T extends TaskItem>(t: T): TaskItem {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    visibility: t.visibility,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    ownerUserId: t.ownerUserId,
    ownerName: t.ownerName,
    company: t.company,
    project: t.project,
    assignee: t.assignee,
    isOverdue: t.isOverdue,
  };
}
