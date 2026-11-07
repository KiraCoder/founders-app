"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CompanyDot, InitialsAvatar, Tag } from "@/components/ui";
import { daysBetween, formatDueDate } from "@/lib/dates";
import type { TaskFormOptions } from "@/server/services/options";
import { PRIORITY_TONE, STATUS_TONE, priorityLabel, statusLabel } from "./labels";
import { TaskActions } from "./TaskActions";
import type { TaskActivityItem, TaskItem } from "./types";
import { ToastScope } from "./ui/Toast";

export function TaskListClient({
  tasks,
  today,
  options,
  empty,
  showCompany,
  activity,
  canChase,
  timeZone,
}: {
  tasks: TaskItem[];
  today: string;
  options: TaskFormOptions;
  empty: string;
  showCompany: boolean;
  activity: Record<string, TaskActivityItem>;
  canChase: boolean;
  timeZone: string;
}) {
  if (tasks.length === 0) {
    return <div className="card px-4 py-6 text-center text-[13px] text-muted">{empty}</div>;
  }
  return (
    <ToastScope>
      <ul className="card divide-y divide-line" aria-label="Tasks">
        {tasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            today={today}
            options={options}
            showCompany={showCompany}
            activity={activity[t.id]}
            canChase={canChase}
            timeZone={timeZone}
          />
        ))}
      </ul>
    </ToastScope>
  );
}

export function DueChip({ task, today }: { task: TaskItem; today: string }) {
  if (!task.dueDate) return null;
  if (task.isOverdue) {
    const days = daysBetween(task.dueDate, today);
    return (
      <Tag tone="risk" title={`Due ${task.dueDate}`}>
        Overdue · <span className="num">{days}d</span>
      </Tag>
    );
  }
  const closed = task.status === "done" || task.status === "cancelled";
  return (
    <Tag tone={!closed && task.dueDate === today ? "warn" : "neutral"} title={`Due ${task.dueDate}`}>
      <span className="num">{formatDueDate(task.dueDate, today)}</span>
    </Tag>
  );
}

export function shortStamp(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

const CHASE_TAG: Record<string, string> = { off: "Not chased", once: "Remind once", every: "Custom chase" };

/** The activity line: last message to the person, their answer, comments, checklist, chase choice. */
export function ActivityLine({ task, a, timeZone }: { task: TaskItem; a?: TaskActivityItem; timeZone: string }) {
  if (!a) return null;
  const person = task.assignee?.kind === "person";
  const bits: ReactNode[] = [];
  if (person && a.lastSent) {
    bits.push(
      <span key="sent" className={a.lastSent.status === "failed" ? "text-risk" : ""} title={`${a.reminders} reminder(s) sent`}>
        📨 {a.lastSent.status === "waiting" ? "Waiting to send" : a.lastSent.what}
        {a.lastSent.status === "failed" ? " — not delivered" : ""} · <span className="num">{shortStamp(a.lastSent.at, timeZone)}</span>
      </span>,
    );
  } else if (person) bits.push(<span key="sent">📨 Nothing sent yet</span>);
  if (person && a.lastReply) {
    bits.push(
      <span key="reply" className="text-ink">
        ↩ {a.lastReply.what} · <span className="num">{shortStamp(a.lastReply.at, timeZone)}</span>
      </span>,
    );
  }
  if (a.comments > 0) {
    bits.push(
      <span key="comments" aria-label={`${a.comments} comments`}>
        💬 <span className="num">{a.comments}</span>
      </span>,
    );
  }
  if (a.checklist) {
    bits.push(
      <span key="check" aria-label={`Checklist ${a.checklist.done} of ${a.checklist.total} done`}>
        ☑ <span className="num">{a.checklist.done}/{a.checklist.total}</span>
      </span>,
    );
  }
  if (person && a.chase.paused) bits.push(<Tag key="paused" tone="warn">⏸ Chasing paused</Tag>);
  else if (person && CHASE_TAG[a.chase.chase]) bits.push(<Tag key="mode">{CHASE_TAG[a.chase.chase]}</Tag>);
  if (!bits.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted" data-testid="task-activity">
      {bits}
    </div>
  );
}

function TaskRow({
  task,
  today,
  options,
  showCompany,
  activity,
  canChase,
  timeZone,
}: {
  task: TaskItem;
  today: string;
  options: TaskFormOptions;
  showCompany: boolean;
  activity?: TaskActivityItem;
  canChase: boolean;
  timeZone: string;
}) {
  const closed = task.status === "done" || task.status === "cancelled";
  return (
    <li className="px-3 py-2.5 sm:px-4" data-task-id={task.id}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/tasks/${task.id}`} className={`text-[14px] hover:underline ${closed ? "text-muted line-through" : "font-medium"}`}>
              {task.title}
            </Link>
            {task.visibility === "private" && (
              <Tag title="Only you can see this">
                <span aria-hidden="true">🔒</span> Personal
              </Tag>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
            <Tag tone={STATUS_TONE[task.status]}>{statusLabel(task.status)}</Tag>
            <DueChip task={task} today={today} />
            {task.priority !== "normal" && <Tag tone={PRIORITY_TONE[task.priority]}>{priorityLabel(task.priority)}</Tag>}
            {showCompany && task.company && (
              <Link href={`/companies/${task.company.slug}`} className="inline-flex items-center gap-1 hover:text-ink">
                <CompanyDot color={task.company.color} size={7} /> {task.company.name}
              </Link>
            )}
            {task.project && (
              <Link href={`/projects/${task.project.id}`} className="inline-flex items-center gap-1 hover:text-ink">
                <span aria-hidden="true">📁</span> {task.project.name}
              </Link>
            )}
            {task.orgDepartment && (
              <span className="tag" title={`Department ${task.orgDepartment.number} ${task.orgDepartment.name} (org chart)`} data-testid="task-department">
                {task.orgDepartment.number} {task.orgDepartment.name}
              </span>
            )}
            {task.assignee && (
              <span className="inline-flex items-center gap-1" aria-label={`Assigned to ${task.assignee.name}`}>
                <InitialsAvatar name={task.assignee.name} size={16} />
                <span>{task.assignee.name}</span>
              </span>
            )}
          </div>
          <ActivityLine task={task} a={activity} timeZone={timeZone} />
        </div>
        <TaskActions task={task} activity={activity} options={options} canChase={canChase} />
      </div>
    </li>
  );
}
