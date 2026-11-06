import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addCommentAction,
  decideDeadlineAction,
  deleteCommentAction,
  editCommentAction,
  setTaskChaseAction,
} from "@/app/(app)/staff-actions";
import { ActionForm } from "@/components/staff/ActionForm";
import { TaskList } from "@/components/tasks/TaskList";
import { toTaskItem } from "@/components/tasks/types";
import { PageHeader, Section, Tag } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { canManageStaffBot } from "@/server/services/access";
import { today } from "@/server/services/context";
import { ServiceError } from "@/server/services/errors";
import { getTaskFormOptions } from "@/server/services/options";
import { getTaskStaffChase } from "@/server/services/staff";
import { getTaskStaffTrail, listDeadlineRequests, listTaskComments } from "@/server/services/task-comments";
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
  const staff = task.assignee?.kind === "person" && canManageStaffBot(ctx);
  const [options, comments, requests, trail, chase] = await Promise.all([
    getTaskFormOptions(ctx),
    listTaskComments(ctx, task.id),
    listDeadlineRequests(ctx, task.id),
    getTaskStaffTrail(ctx, task.id),
    staff ? getTaskStaffChase(ctx, task.id) : Promise.resolve(null),
  ]);
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: ctx.timeZone });
  const pending = requests.filter((r) => r.status === "pending");

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/tasks?view=company" className="hover:underline">
            Tasks
          </Link>
        }
        title={task.title}
      />
      <div className="mb-5">
        <TaskList tasks={[toTaskItem(task)]} today={today(ctx)} options={options} />
      </div>

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
        <ActionForm action={addCommentAction} label="Add comment" className="flex flex-col gap-2">
          <input type="hidden" name="taskId" value={task.id} />
          <textarea name="text" required maxLength={4000} className="input min-h-[70px]" placeholder="Write a comment…" aria-label="New comment" />
          <div>
            <button type="submit" className="btn btn-primary">
              Add comment
            </button>
          </div>
        </ActionForm>
      </Section>

      {(trail.length > 0 || staff) && (
        <Section title="Telegram delivery" count={trail.length}>
          <ul className="card mb-3 divide-y divide-line text-[13px]" aria-label="Delivery trail">
            {trail.length === 0 && <li className="px-4 py-3 text-muted">Nothing sent to {task.assignee?.name} yet.</li>}
            {trail.map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-2 px-4 py-2" data-testid="trail-entry">
                <span className="num text-muted">{fmt.format(e.at)}</span>
                <span className="font-medium">{e.what}</span>
                <span className="text-muted">· {e.who}</span>
              </li>
            ))}
          </ul>
          {staff && chase && (
            <details className="card mb-3 p-4">
              <summary className="cursor-pointer text-[13px]">
                Chasing for this task {Object.keys(chase).length ? "(changed)" : `(${task.assignee?.name}'s settings)`}
              </summary>
              <ActionForm action={setTaskChaseAction} label="Task chase settings" className="mt-3 flex flex-col gap-3">
                <input type="hidden" name="taskId" value={task.id} />
                <div className="grid gap-3 sm:grid-cols-4">
                  <label className="flex flex-col gap-1">
                    <span className="label">Chase</span>
                    <select name="chaseEnabled" className="input" defaultValue={chase.chaseEnabled === undefined ? "" : chase.chaseEnabled ? "on" : "false"}>
                      <option value="">Default (on)</option>
                      <option value="on">On</option>
                      <option value="false">Off for this task</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="label">Every (minutes)</span>
                    <input type="number" min={15} max={1440} name="chaseEveryMinutes" className="input" defaultValue={chase.chaseEveryMinutes ?? ""} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="label">Tell founder after N unanswered</span>
                    <input type="number" min={0} max={50} name="escalateAfterChases" className="input" defaultValue={chase.escalateAfterChases ?? ""} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="label">Tell founder if open at</span>
                    <input type="time" name="escalateAt" className="input" defaultValue={chase.escalateAt ?? ""} />
                  </label>
                </div>
                <div className="flex gap-2">
                  <button type="submit" className="btn btn-sm btn-primary">
                    Save
                  </button>
                  <button type="submit" name="clear" value="1" className="btn btn-sm">
                    Use the person&apos;s settings
                  </button>
                </div>
              </ActionForm>
            </details>
          )}
        </Section>
      )}

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
