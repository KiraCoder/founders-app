import Link from "next/link";
import { notFound } from "next/navigation";
import { addCommentAction, decideDeadlineAction } from "@/app/(app)/staff-actions";
import { ActionForm } from "@/components/staff/ActionForm";
import { TaskActions } from "@/components/tasks/TaskActions";
import { TaskChasePanel } from "@/components/tasks/TaskChasePanel";
import { TaskChecklist } from "@/components/tasks/TaskChecklist";
import { CommentCard, TaskDescriptionEditor, TaskPropertiesPanel, TaskTitleEditor } from "@/components/tasks/TaskDetail";
import { PriorityIcon, StatusIcon } from "@/components/tasks/TaskIcons";
import { priorityLabel, statusLabel } from "@/components/tasks/labels";
import { TaskList } from "@/components/tasks/TaskList";
import { toTaskItem, type TaskActivityItem } from "@/components/tasks/types";
import { BackLink } from "@/components/ui/BackLink";
import { InitialsAvatar, Tag } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { canManageStaffBot } from "@/server/services/access";
import { today } from "@/server/services/context";
import { ServiceError } from "@/server/services/errors";
import { getTaskFormOptions } from "@/server/services/options";
import { getTaskTimeline, personChaseSettings, taskActivityFor } from "@/server/services/task-activity";
import { listChecklist } from "@/server/services/task-checklist";
import { listDeadlineRequests, listTaskComments } from "@/server/services/task-comments";
import { getTask, listChildTasks } from "@/server/services/tasks";

export const metadata = { title: "Task" };
export const dynamic = "force-dynamic";

/**
 * A task, Linear style (0034): "← Back", the key, a big editable title, the description
 * (Markdown, edited in place), Sub-tasks (the checklist; each can be promoted to a task),
 * Activity (everything that happened, bot messages and staff replies included, merged with the
 * comments) with the comment box at the bottom, and a Properties sidebar where every property
 * changes inline.
 */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getPageContext();
  let task;
  try {
    task = await getTask(ctx, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "not_found") notFound();
    throw err;
  }
  const founders = canManageStaffBot(ctx);
  const person = task.assignee?.kind === "person" ? task.assignee : null;
  const [options, comments, requests, timeline, checklist, activityMap, personSettings, children, parent] = await Promise.all([
    getTaskFormOptions(ctx),
    listTaskComments(ctx, task.id),
    listDeadlineRequests(ctx, task.id),
    getTaskTimeline(ctx, task.id),
    listChecklist(ctx, task.id),
    taskActivityFor(ctx, [task]),
    person && founders ? personChaseSettings(ctx, [person.id]) : Promise.resolve({} as Awaited<ReturnType<typeof personChaseSettings>>),
    listChildTasks(ctx, task.id),
    task.parentTaskId ? getTask(ctx, task.parentTaskId).catch(() => null) : Promise.resolve(null),
  ]);
  const activity = JSON.parse(JSON.stringify(activityMap[task.id] ?? null)) as TaskActivityItem | null;
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: ctx.timeZone });
  const pending = requests.filter((r) => r.status === "pending");
  const item = toTaskItem(task);
  const day = today(ctx);
  const ps = person ? (personSettings[person.id] ?? null) : null;
  const nudged = task.assignee?.kind === "user" ? task.assignee.name : task.ownerName;
  const back = "/tasks";
  const closed = task.status === "done" || task.status === "cancelled";
  const notifyName = person && activity?.sentToPerson && !closed ? person.name : null;

  // Activity: history entries and comments, oldest first.
  type Entry = { at: Date; kind: "event"; e: (typeof timeline)[number] } | { at: Date; kind: "comment"; c: (typeof comments)[number] };
  const entries: Entry[] = [
    ...timeline.map((e) => ({ at: e.at, kind: "event" as const, e })),
    ...comments.map((c) => ({ at: c.createdAt, kind: "comment" as const, c })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const chase =
    task.visibility === "shared" && activity && (founders || !person) ? (
      <TaskChasePanel
        taskId={task.id}
        value={activity.chase}
        assignee={task.assignee ? { kind: task.assignee.kind, name: task.assignee.name } : null}
        nudgedFounder={nudged}
        person={ps}
        dueDate={task.dueDate}
        unreachable={ps?.unreachable ?? null}
        hasNotes
      />
    ) : undefined;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <BackLink href={back} ariaLabel="Back to tasks" />
        <nav className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted" aria-label="Breadcrumb">
          <Link href={back} className="hover:text-ink hover:underline">
            Tasks
          </Link>
          <span aria-hidden="true">/</span>
          {task.company && (
            <>
              <Link href={`/tasks?company=${task.company.id}`} className="truncate hover:text-ink hover:underline">
                {task.company.name}
              </Link>
              <span aria-hidden="true">/</span>
            </>
          )}
          <span className="num font-medium text-ink" data-testid="task-key">
            {task.key}
          </span>
        </nav>
        <div className="ml-auto">
          <TaskActions task={item} activity={activity ?? undefined} options={options} showOpen={false} canChase={founders} afterDelete={back} timeZone={ctx.timeZone} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {parent && (
            <p className="mb-1 text-[12.5px] text-muted">
              Sub-task of{" "}
              <Link href={`/tasks/${parent.id}`} className="hover:text-ink hover:underline">
                <span className="num">{parent.key}</span> {parent.title}
              </Link>
            </p>
          )}
          <TaskTitleEditor taskId={task.id} title={task.title} closed={task.status === "cancelled"} />
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <span className="inline-flex items-center gap-1" data-testid="task-status-line">
              <StatusIcon status={task.status} size={12} /> {statusLabel(task.status)}
            </span>
            {task.priority !== "none" && (
              <span className="inline-flex items-center gap-1">
                <PriorityIcon priority={task.priority} size={12} /> {priorityLabel(task.priority)}
              </span>
            )}
            {task.estimate && <span className="num">▲ {task.estimate}</span>}
            {task.isOverdue && <Tag tone="risk">Overdue</Tag>}
            {task.overEstimate && <Tag tone="warn">Over estimate</Tag>}
            {task.visibility === "private" && <Tag>🔒 Personal</Tag>}
            {person && activity?.lastSent && (
              <span className={activity.lastSent.status === "failed" ? "text-risk" : ""}>
                📨 {activity.lastSent.status === "waiting" ? "Waiting to send" : activity.lastSent.what} · {fmt.format(new Date(activity.lastSent.at))}
              </span>
            )}
            {person && activity?.chase.paused && <Tag tone="warn">⏸ Chasing paused</Tag>}
          </div>

          <section className="mt-4" aria-label="Description">
            <TaskDescriptionEditor taskId={task.id} notes={task.notes} />
          </section>

          {pending.length > 0 && (
            <section className="card mt-5 border-warn p-4" aria-labelledby="deadline-req-heading">
              <h2 id="deadline-req-heading" className="eyebrow mb-2">
                Deadline change requested
              </h2>
              {pending.map((r) => (
                <ActionForm key={r.id} action={decideDeadlineAction} label="Deadline request" className="flex flex-wrap items-center gap-2 text-[13px]">
                  <input type="hidden" name="requestId" value={r.id} />
                  <span>
                    {r.personName} asks to move the deadline {r.currentDueDate ? `from ${r.currentDueDate} ` : ""}to <strong className="num">{r.proposedDueDate}</strong> (
                    {fmt.format(r.createdAt)}).
                  </span>
                  <button type="submit" name="decision" value="approve" className="btn btn-sm btn-primary">
                    Approve
                  </button>
                  <button type="submit" name="decision" value="decline" className="btn btn-sm">
                    Decline
                  </button>
                </ActionForm>
              ))}
            </section>
          )}

          <section className="mt-6" aria-labelledby="subtasks-heading">
            <h2 id="subtasks-heading" className="eyebrow mb-2">
              Sub-tasks <span className="num">{checklist.length + children.length}</span>
            </h2>
            <TaskChecklist
              taskId={task.id}
              items={checklist.map((c) => ({ ...c, doneAt: c.doneAt ? c.doneAt.toISOString() : null }))}
              notifyName={notifyName}
              timeZone={ctx.timeZone}
              canPromote
            />
            {children.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-[12px] text-muted">Promoted to tasks</p>
                <TaskList tasks={children.map(toTaskItem)} today={day} options={options} hidden={["created", "updated", "activity", "project", "company"]} />
              </div>
            )}
          </section>

          <div id="comments" className="scroll-mt-20" />
          <section className="mt-6" aria-labelledby="activity-heading">
            <h2 id="activity-heading" className="eyebrow mb-2">
              Activity
            </h2>
            <ol className="relative space-y-2 border-l border-line pl-4" aria-label="Timeline">
              {person && activity && !activity.sentToPerson && <li className="text-[13px] text-muted">Nothing sent to {person.name} yet.</li>}
              {entries.map((x, i) =>
                x.kind === "event" ? (
                  <li key={`e${i}`} className="relative flex flex-wrap items-baseline gap-x-2 text-[13px]" data-testid="trail-entry">
                    <span aria-hidden="true" className="absolute -left-[22px] top-0.5 grid size-3 place-items-center rounded-full border border-line bg-surface text-[8px]" />
                    <span aria-hidden="true" className="w-4 shrink-0 text-center text-[12px]">
                      {x.e.icon}
                    </span>
                    <span className="text-muted">{x.e.who}</span>
                    <span className={`${x.e.tone === "risk" ? "text-risk" : x.e.tone === "ok" ? "text-ok" : "text-ink"}`}>{x.e.what}</span>
                    <span className="num text-[12px] text-muted">· {fmt.format(x.e.at)}</span>
                  </li>
                ) : (
                  <li key={`c${x.c.id}`} className="relative">
                    <span aria-hidden="true" className="absolute -left-[26px] top-2">
                      <InitialsAvatar name={x.c.authorName} size="xs" tone={x.c.source === "telegram" ? "neutral" : "accent"} />
                    </span>
                    <CommentCard
                      id={x.c.id}
                      author={x.c.authorName}
                      text={x.c.text}
                      at={fmt.format(x.c.createdAt)}
                      edited={!!x.c.editedAt}
                      telegram={x.c.source === "telegram"}
                      help={x.c.kind === "help"}
                      mine={x.c.mine}
                    />
                  </li>
                ),
              )}
            </ol>
            {person && activity && (
              <p className="mt-2 text-[12px] text-muted" data-testid="reminder-count">
                Reminders sent to {person.name}: <span className="num">{activity.reminders}</span>
              </p>
            )}
            <ActionForm action={addCommentAction} label="Add comment" className="mt-4 flex flex-col gap-2">
              <input type="hidden" name="taskId" value={task.id} />
              <textarea name="text" required maxLength={4000} className="input min-h-[76px]" placeholder="Leave a comment…" aria-label="New comment" />
              <div>
                <button type="submit" className="btn btn-primary btn-sm">
                  Comment
                </button>
              </div>
            </ActionForm>
          </section>

          {requests.some((r) => r.status !== "pending") && (
            <section className="mt-6" aria-labelledby="deadline-history">
              <h2 id="deadline-history" className="eyebrow mb-2">
                Deadline requests
              </h2>
              <ul className="card divide-y divide-line text-[13px]">
                {requests
                  .filter((r) => r.status !== "pending")
                  .map((r) => (
                    <li key={r.id} className="flex flex-wrap gap-x-2 px-4 py-2">
                      <span className="num text-muted">{fmt.format(r.createdAt)}</span>
                      <span>
                        {r.personName} → {r.proposedDueDate}
                      </span>
                      <Tag tone={r.status === "approved" ? "ok" : "neutral"}>{r.status}</Tag>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </div>

        <TaskPropertiesPanel
          task={item}
          options={options}
          today={day}
          createdLine={
            <>
              {task.ownerName} · <span className="num">{fmt.format(task.createdAt)}</span>
              {task.completedAt && (
                <>
                  <br />
                  Completed <span className="num">{fmt.format(task.completedAt)}</span>
                </>
              )}
            </>
          }
          chase={chase}
        />
      </div>
    </>
  );
}
