import Link from "next/link";
import { notFound } from "next/navigation";
import { addCommentAction, decideDeadlineAction, deleteCommentAction, editCommentAction } from "@/app/(app)/staff-actions";
import { ActionForm } from "@/components/staff/ActionForm";
import { labelsFor } from "@/components/tasks/labels";
import { TaskActions } from "@/components/tasks/TaskActions";
import { TaskChasePanel } from "@/components/tasks/TaskChasePanel";
import { TaskChecklist } from "@/components/tasks/TaskChecklist";
import { ActivityLine, DueChip } from "@/components/tasks/TaskListClient";
import { toTaskItem, type TaskActivityItem } from "@/components/tasks/types";
import { BackLink } from "@/components/ui/BackLink";
import { CompanyDot, InitialsAvatar, Section, Tag } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { canManageStaffBot } from "@/server/services/access";
import { today } from "@/server/services/context";
import { ServiceError } from "@/server/services/errors";
import { getTaskFormOptions } from "@/server/services/options";
import { getTaskTimeline, personChaseSettings, taskActivityFor } from "@/server/services/task-activity";
import { listChecklist } from "@/server/services/task-checklist";
import { listDeadlineRequests, listTaskComments } from "@/server/services/task-comments";
import { getTask } from "@/server/services/tasks";

export const metadata = { title: "Task" };
export const dynamic = "force-dynamic";

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
  const [options, comments, requests, timeline, checklist, activityMap, personSettings] = await Promise.all([
    getTaskFormOptions(ctx),
    listTaskComments(ctx, task.id),
    listDeadlineRequests(ctx, task.id),
    getTaskTimeline(ctx, task.id),
    listChecklist(ctx, task.id),
    taskActivityFor(ctx, [task]),
    person && founders ? personChaseSettings(ctx, [person.id]) : Promise.resolve({} as Awaited<ReturnType<typeof personChaseSettings>>),
  ]);
  const activity = JSON.parse(JSON.stringify(activityMap[task.id] ?? null)) as TaskActivityItem | null;
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: ctx.timeZone });
  const pending = requests.filter((r) => r.status === "pending");
  const item = toTaskItem(task);
  const day = today(ctx);
  const ps = person ? (personSettings[person.id] ?? null) : null;
  const nudged = task.assignee?.kind === "user" ? task.assignee.name : task.ownerName;
  const back = task.visibility === "private" ? "/tasks?view=my" : "/tasks?view=company";
  const notifyName = person && activity?.sentToPerson && task.status !== "done" && task.status !== "cancelled" ? person.name : null;
  const L = labelsFor(task);

  return (
    <>
      <BackLink href={back} ariaLabel="Back to tasks" className="mb-3" />
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="eyebrow">
            <Link href={back} className="hover:underline">
              Tasks
            </Link>
          </p>
          <h1 className={`mt-1 text-[22px] font-semibold leading-tight ${task.status === "cancelled" ? "text-muted line-through" : ""}`}>{task.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
            <Tag tone={L.statusTone}>{L.status}</Tag>
            <DueChip task={item} today={day} />
            {task.priority !== "normal" && <Tag tone={L.priorityTone}>{L.priority}</Tag>}
            {task.visibility === "private" && <Tag>🔒 Personal</Tag>}
          </div>
          <ActivityLine task={item} a={activity ?? undefined} timeZone={ctx.timeZone} />
        </div>
        <TaskActions task={item} activity={activity ?? undefined} options={options} showOpen={false} canChase={founders} afterDelete={back} />
      </header>

      <section className="card mb-5 p-4" aria-labelledby="task-details-heading">
        <h2 id="task-details-heading" className="sr-only">
          Details
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3" data-testid="task-details">
          <Detail label="Assignee">
            {task.assignee ? (
              <span className="inline-flex items-center gap-1.5">
                <InitialsAvatar name={task.assignee.name} size={18} />
                {person ? <Link href={`/people/${person.id}`} className="hover:underline">{person.name}</Link> : task.assignee.name}
                {person && <span className="text-muted">(Telegram)</span>}
              </span>
            ) : (
              <span className="text-muted">Nobody</span>
            )}
          </Detail>
          <Detail label="Company">
            {task.company ? (
              <Link href={`/companies/${task.company.slug}`} className="inline-flex items-center gap-1.5 hover:underline">
                <CompanyDot color={task.company.color} size={8} /> {task.company.name}
              </Link>
            ) : (
              <span className="text-muted">None</span>
            )}
          </Detail>
          <Detail label="Due">{task.dueDate ? <span className="num">{task.dueDate}</span> : <span className="text-muted">No due date</span>}</Detail>
          <Detail label="Project">{task.project ? <Link href={`/projects/${task.project.id}`} className="hover:underline">{task.project.name}</Link> : <span className="text-muted">None</span>}</Detail>
          {task.orgDepartment && (
            <Detail label="Department">
              <span data-testid="task-department">
                {task.orgDepartment.number} {task.orgDepartment.name}
              </span>
            </Detail>
          )}
          <Detail label="Who sees it">{task.visibility === "private" ? "Only the creator" : "Both founders"}</Detail>
          <Detail label="Created">
            {task.ownerName} · <span className="num">{fmt.format(task.createdAt)}</span>
          </Detail>
          {task.completedAt && (
            <Detail label="Completed">
              <span className="num">{fmt.format(task.completedAt)}</span>
            </Detail>
          )}
        </dl>
        {task.notes && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="label">Notes</p>
            <p className="whitespace-pre-wrap text-[14px]">{task.notes}</p>
          </div>
        )}
      </section>

      {pending.length > 0 && (
        <section className="card mb-5 border-warn p-4" aria-labelledby="deadline-req-heading">
          <h2 id="deadline-req-heading" className="eyebrow mb-2">
            Deadline change requested
          </h2>
          {pending.map((r) => (
            <ActionForm key={r.id} action={decideDeadlineAction} label="Deadline request" className="flex flex-wrap items-center gap-2 text-[13px]">
              <input type="hidden" name="requestId" value={r.id} />
              <span>
                {r.personName} asks to move the deadline {r.currentDueDate ? `from ${r.currentDueDate} ` : ""}to{" "}
                <strong className="num">{r.proposedDueDate}</strong> ({fmt.format(r.createdAt)}).
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

      <Section title="Checklist" count={checklist.length}>
        <div className="mb-5">
          <TaskChecklist
            taskId={task.id}
            items={checklist.map((c) => ({ ...c, doneAt: c.doneAt ? c.doneAt.toISOString() : null }))}
            notifyName={notifyName}
            timeZone={ctx.timeZone}
          />
        </div>
      </Section>

      {task.visibility === "shared" && activity && (founders || !person) && (
        <Section title="Reminders">
          <div className="mb-5">
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
          </div>
        </Section>
      )}

      <Section title="Comments" count={comments.length}>
        <ul className="card mb-3 divide-y divide-line" aria-label="Comments">
          {comments.length === 0 && <li className="px-4 py-4 text-[13px] text-muted">No comments yet.</li>}
          {comments.map((c) => (
            <li key={c.id} className="px-4 py-3 text-[13px]" data-testid="task-comment">
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                <span className="font-semibold text-ink">{c.authorName}</span>
                {c.source === "telegram" && <Tag tone="info">Telegram</Tag>}
                {c.kind === "help" && <Tag tone="warn">Needs help</Tag>}
                <span className="num">{fmt.format(c.createdAt)}</span>
                {c.editedAt && <span>(edited)</span>}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{c.text}</p>
              {c.mine && (
                <div className="mt-1 flex flex-wrap items-start gap-2">
                  <details>
                    <summary className="cursor-pointer text-[12px] text-muted">Edit</summary>
                    <ActionForm action={editCommentAction} label="Edit comment" className="mt-1 flex flex-col gap-2">
                      <input type="hidden" name="commentId" value={c.id} />
                      <textarea name="text" defaultValue={c.text} className="input min-h-[60px]" maxLength={4000} aria-label="Comment text" />
                      <div>
                        <button type="submit" className="btn btn-sm">
                          Save
                        </button>
                      </div>
                    </ActionForm>
                  </details>
                  <ActionForm action={deleteCommentAction} label="Delete comment">
                    <input type="hidden" name="commentId" value={c.id} />
                    <button type="submit" className="btn btn-ghost btn-sm text-risk">
                      Delete
                    </button>
                  </ActionForm>
                </div>
              )}
            </li>
          ))}
        </ul>
        <ActionForm action={addCommentAction} label="Add comment" className="mb-5 flex flex-col gap-2">
          <input type="hidden" name="taskId" value={task.id} />
          <textarea name="text" required maxLength={4000} className="input min-h-[70px]" placeholder="Write a comment…" aria-label="New comment" />
          <div>
            <button type="submit" className="btn btn-primary">
              Add comment
            </button>
          </div>
        </ActionForm>
      </Section>

      <Section title="Timeline" count={timeline.length}>
        <ol className="card mb-5 divide-y divide-line text-[13px]" aria-label="Timeline">
          {timeline.length === 0 && <li className="px-4 py-3 text-muted">Nothing yet.</li>}
          {person && activity && !activity.sentToPerson && (
            <li className="px-4 py-2 text-muted">Nothing sent to {person.name} yet.</li>
          )}
          {timeline.map((e, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2" data-testid="trail-entry">
              <span aria-hidden="true" className="w-5 shrink-0 text-center">
                {e.icon}
              </span>
              <span className="num w-[110px] shrink-0 text-muted">{fmt.format(e.at)}</span>
              <span className={`font-medium ${e.tone === "risk" ? "text-risk" : e.tone === "ok" ? "text-ok" : ""}`}>{e.what}</span>
              <span className="text-muted">· {e.who}</span>
            </li>
          ))}
        </ol>
        {person && activity && (
          <p className="mb-5 text-[12px] text-muted" data-testid="reminder-count">
            Reminders sent to {person.name}: <span className="num">{activity.reminders}</span>
          </p>
        )}
      </Section>

      {requests.some((r) => r.status !== "pending") && (
        <Section title="Deadline requests" count={requests.length - pending.length}>
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
        </Section>
      )}
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="label">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
