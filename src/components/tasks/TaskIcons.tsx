/**
 * Status and priority icons of tasks (0034), drawn like Linear's but in our tokens: a circle per
 * status (dashed Backlog, empty Todo, half In Progress, three quarters In Review, filled check
 * Done, filled cross Canceled) and "antenna" bars per priority (Urgent: an orange square with "!").
 * Pure SVG, no state: used by the list rows, menus, group headers and the task page.
 */
import type { TaskPriorityValue, TaskStatusValue } from "@/lib/schemas";

export const STATUS_COLOR: Record<TaskStatusValue, string> = {
  backlog: "var(--muted)",
  todo: "var(--muted)",
  in_progress: "var(--warn)",
  in_review: "var(--info)",
  done: "var(--accent)",
  cancelled: "var(--muted)",
};

export function StatusIcon({ status, size = 14, className }: { status: TaskStatusValue | string; size?: number; className?: string }) {
  const s = (status in STATUS_COLOR ? status : "todo") as TaskStatusValue;
  const color = STATUS_COLOR[s];
  const common = { width: size, height: size, viewBox: "0 0 14 14", "aria-hidden": true as const, className, style: { flexShrink: 0 } };
  switch (s) {
    case "backlog":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="5.75" stroke={color} strokeWidth="1.5" strokeDasharray="2.2 2" />
        </svg>
      );
    case "todo":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="5.75" stroke={color} strokeWidth="1.5" />
        </svg>
      );
    case "in_progress":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="5.75" stroke={color} strokeWidth="1.5" />
          <path d="M7 3.25a3.75 3.75 0 0 1 0 7.5Z" fill={color} />
        </svg>
      );
    case "in_review":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="5.75" stroke={color} strokeWidth="1.5" />
          <path d="M7 3.25A3.75 3.75 0 1 1 3.25 7H7Z" fill={color} />
        </svg>
      );
    case "done":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="6.5" fill={color} />
          <path d="M4.3 7.2l1.8 1.8 3.6-3.8" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...common} fill="none">
          <circle cx="7" cy="7" r="6.5" fill={color} />
          <path d="M5 5l4 4M9 5l-4 4" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
  }
}

export function PriorityIcon({ priority, size = 14, className }: { priority: TaskPriorityValue | string; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: "0 0 14 14", "aria-hidden": true as const, className, style: { flexShrink: 0 } };
  if (priority === "urgent") {
    return (
      <svg {...common}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--urgent)" />
        <path d="M7 3.6v4.2" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="7" cy="10.2" r="1" fill="#fff" />
      </svg>
    );
  }
  if (priority === "none" || !["high", "medium", "low"].includes(priority)) {
    return (
      <svg {...common} fill="var(--muted)">
        <rect x="1.5" y="6.25" width="2.5" height="1.5" rx="0.75" />
        <rect x="5.75" y="6.25" width="2.5" height="1.5" rx="0.75" />
        <rect x="10" y="6.25" width="2.5" height="1.5" rx="0.75" />
      </svg>
    );
  }
  const on = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  const bars = [
    { x: 1.5, y: 8, h: 4 },
    { x: 5.75, y: 5, h: 7 },
    { x: 10, y: 2, h: 10 },
  ];
  return (
    <svg {...common}>
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width="2.5" height={b.h} rx="0.75" fill={i < on ? "var(--ink)" : "var(--line)"} />
      ))}
    </svg>
  );
}

/** The estimate as Linear shows it: a small triangle and the points ("▲ 5"). */
export function EstimateIcon({ size = 10, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true" className={className} style={{ flexShrink: 0 }}>
      <path d="M5 1.2 9 8.6H1Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
