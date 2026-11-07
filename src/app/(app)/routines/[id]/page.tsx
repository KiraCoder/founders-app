import Link from "next/link";
import { notFound } from "next/navigation";
import { RoutineActions } from "@/components/routines/RoutineActions";
import { RoutineChecklistCard } from "@/components/routines/RoutineChecklistCard";
import { formatNextDue } from "@/components/routines/RoutinesList";
import { RoutineStatusScope, RoutineStatusTag } from "@/components/routines/RoutineStatus";
import { routineFormValues, todayRunOf } from "@/components/routines/form-values";
import { BackLink } from "@/components/ui/BackLink";
import { PageHeader, Section, Tag, type Tone } from "@/components/ui";
import { formatDisplayDate } from "@/lib/dates";
import { getPageContext } from "@/server/context";
import { canManageRoutines } from "@/server/services/access";
import { ServiceError } from "@/server/services/errors";
import { getRoutine, listRoutineMessages, listRoutineRuns, routineFormOptions } from "@/server/services/routines";

export const metadata = { title: "Routine" };
export const dynamic = "force-dynamic";

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  on_time: { label: "Done on time", tone: "ok" },
  late: { label: "Done late", tone: "warn" },
  partly: { label: "Partly", tone: "warn" },
  missed: { label: "Missed", tone: "risk" },
  cant: { label: "Can't (see comment)", tone: "risk" },
  open: { label: "Open", tone: "info" },
};
const STATE_EMOJI: Record<string, string> = { done: "✅", partly: "🟡", cant: "❌", open: "⬜" };
const STATE_LABEL: Record<string, string> = { done: "done", partly: "partly", cant: "can't", open: "open" };
const KIND_LABEL: Record<string, string> = { comment: "Comment", done: "Comment on tick", partly: "Partly", cant: "Can't" };

/** A routine, read-only: what the bot does, the checklist, run history, comments and every message sent. Edit opens a dialog. */
export default async function RoutinePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getPageContext();
  if (!canManageRoutines(ctx)) notFound();
  let view;
  try {
    view = await getRoutine(ctx, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "not_found") notFound();
    throw err;
  }
  const [runs, options, messages] = await Promise.all([listRoutineRuns(ctx, id), routineFormOptions(ctx), listRoutineMessages(ctx, id)]);
  const r = view.routine;
  const tz = r.timezone;
  const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  const dt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: tz });
  const comments = runs.flatMap((x) => x.comments.map((c) => ({ ...c, runDate: x.run.runDate }))).sort((a, b) => b.at.getTime() - a.at.getTime());
  return (
    <>
      <BackLink href="/routines" className="mb-2" />
      <RoutineStatusScope status={view.status}>
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              {r.title}
              <RoutineStatusTag status={view.status} />
            </span>
          }
          actions={
            <RoutineActions
              variant="page"
              data={{ id: r.id, title: r.title, status: view.status, todayStatus: view.today?.status ?? null, hasRuns: runs.length > 0, commentsCount: view.commentsCount }}
              edit={view.status === "archived" ? null : { initial: routineFormValues(view), today: todayRunOf(view), options, openInitially: sp.edit === "1" }}
            />
          }
        >
          <p className="mt-2 max-w-[760px] rounded-[var(--radius-btn)] bg-accent-soft px-3 py-2 text-[13px] leading-relaxed" data-testid="routine-plan">
            {view.planText}
          </p>
          {view.assigneeKind === "person" && !view.reachable && (
            <p className="mt-2 text-[12px] text-warn">
              The bot may not message {view.assigneeName} now, so runs do not open. Invite them / switch them on in{" "}
              <Link href="/settings/team-telegram" className="underline">
                Team on Telegram
              </Link>
              .
            </p>
          )}
        </PageHeader>
      </RoutineStatusScope>

      <dl className="card mb-6 grid gap-x-6 gap-y-3 p-4 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="label">Who</dt>
          <dd>
            {view.assigneeName} {view.assigneeKind === "founder" ? "(founder, own channel and rules)" : "(Telegram, Russian)"}
          </dd>
        </div>
        <div>
          <dt className="label">Company</dt>
          <dd>{view.companySlug ? <Link href={`/companies/${view.companySlug}`} className="hover:underline">{view.companyName}</Link> : "Group-wide"}</dd>
        </div>
        <div>
          <dt className="label">Schedule</dt>
          <dd>{view.scheduleText} (Asia/Bishkek)</dd>
        </div>
        <div>
          <dt className="label">Next ask</dt>
          <dd>{view.status === "active" ? formatNextDue(view.nextDueAt, tz, ctx.now) : "—"}</dd>
        </div>
        <div>
          <dt className="label">Dates</dt>
          <dd>
            {r.startsOn ? `from ${formatDisplayDate(r.startsOn)}` : "no start date"} · {r.endsOn ? `until ${formatDisplayDate(r.endsOn)}` : "no end date"}
          </dd>
        </div>
        <div>
          <dt className="label">Confirmation</dt>
          <dd>{r.confirmation === "checklist" ? `Checklist, ${r.items.length} item${r.items.length === 1 ? "" : "s"}` : "One button (Готово)"}</dd>
        </div>
      </dl>

      <RoutineChecklistCard
        routineId={r.id}
        items={r.confirmation === "checklist" ? routineFormValues(view).items : []}
        today={todayRunOf(view)}
        assigneeName={view.assigneeName}
        canEdit={view.status !== "archived"}
      />

      <Section title="Run history" count={runs.length}>
        {runs.length === 0 ? (
          <p className="card px-4 py-4 text-[13px] text-muted">No runs yet. The first opens on the next scheduled day at {view.times[0]}, or press Run now.</p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]" aria-label="Run history">
              <thead className="border-b border-line text-[12px] text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Result</th>
                  <th className="px-2 py-2 font-medium">Items</th>
                  <th className="px-2 py-2 font-medium">Reminders</th>
                  <th className="px-4 py-2 font-medium">Escalated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line align-top">
                {runs.map(({ run, outcome, progress, items, reminders, asks }) => (
                  <tr key={run.id} data-testid="routine-run">
                    <td className="num px-4 py-2.5 whitespace-nowrap">
                      {formatDisplayDate(run.runDate)}
                      <div className="text-[12px] text-muted">asked {asks.length ? asks.map((a) => hm.format(a)).join(", ") : hm.format(run.startedAt)}</div>
                    </td>
                    <td className="px-2 py-2.5">
                      <Tag tone={OUTCOME[outcome]!.tone}>{run.status === "escalated" ? "Open · founders told" : OUTCOME[outcome]!.label}</Tag>
                      <div className="mt-1 text-[12px] text-muted">
                        {progress.done}/{progress.total} {run.items.length ? "ticked" : "done"}
                        {run.doneAt ? ` · done ${hm.format(run.doneAt)}` : ""}
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      <ul className="flex flex-col gap-0.5">
                        {items.map((i) => (
                          <li key={i.key}>
                            <span aria-label={STATE_LABEL[i.state]}>{STATE_EMOJI[i.state]}</span> {i.label}
                            {i.at && (
                              <span className="text-[12px] text-muted">
                                {" "}
                                · {hm.format(i.at)}
                                {i.by ? ` by ${i.by}` : ""}
                              </span>
                            )}
                            {i.comment && <span className="block pl-5 text-[12px] italic">“{i.comment}”</span>}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-2 py-2.5 text-[12px]">
                      {reminders.length ? (
                        <>
                          {reminders.length} · {reminders.map((x) => hm.format(x)).join(", ")}
                        </>
                      ) : (
                        <span className="text-muted">none</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-[12px]">{run.escalatedAt ? `yes, ${hm.format(run.escalatedAt)}` : <span className="text-muted">no</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div id="comments" className="scroll-mt-20">
        <Section title="Comments" count={comments.length}>
          {comments.length === 0 ? (
            <p className="card px-4 py-4 text-[13px] text-muted">No comments yet. The person can add one in the bot («💬 Комментарий»); «Частично» and «Не могу» always come with one.</p>
          ) : (
            <ul className="card divide-y divide-line text-[13px]" aria-label="Comments">
              {comments.map((c) => (
                <li key={c.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                    <span className="font-medium text-ink">{c.author}</span>
                    <span>{dt.format(c.at)}</span>
                    <Tag tone={c.kind === "cant" ? "risk" : c.kind === "partly" ? "warn" : "neutral"}>{KIND_LABEL[c.kind] ?? c.kind}</Tag>
                    <span>{c.itemLabel ?? "whole run"}</span>
                  </div>
                  <p className="mt-1">{c.text}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Message log" count={messages.length}>
        {messages.length === 0 ? (
          <p className="card px-4 py-4 text-[13px] text-muted">Nothing sent yet.</p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[13px]" aria-label="Message log">
              <thead className="border-b border-line text-[12px] text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-2 py-2 font-medium">Kind</th>
                  <th className="px-2 py-2 font-medium">To</th>
                  <th className="px-4 py-2 font-medium">Delivered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {messages.map((m) => (
                  <tr key={m.id} data-testid="routine-message">
                    <td className="num px-4 py-2 whitespace-nowrap">{dt.format(m.at)}</td>
                    <td className="px-2 py-2">{m.kind}</td>
                    <td className="px-2 py-2">{m.to}</td>
                    <td className="px-4 py-2">
                      {m.status === "sent" ? (
                        <Tag tone="ok">sent</Tag>
                      ) : (
                        <span className="text-[12px] text-muted">
                          {m.status}
                          {m.reason ? ` · ${m.reason.replace(/_/g, " ")}` : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
