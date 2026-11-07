import Link from "next/link";
import { notFound } from "next/navigation";
import { RoutineForm } from "@/components/routines/RoutineForm";
import type { RoutineFormValues } from "@/components/routines/form-values";
import { ActionForm } from "@/components/staff/ActionForm";
import { PageHeader, Section, Tag, type Tone } from "@/components/ui";
import { formatDisplayDate } from "@/lib/dates";
import { getPageContext } from "@/server/context";
import { canManageRoutines } from "@/server/services/access";
import { ServiceError } from "@/server/services/errors";
import { getRoutine, listRoutineRuns, routineFormOptions } from "@/server/services/routines";
import { deleteRoutineAction, runRoutineNowAction, setRoutineStatusAction, updateRoutineAction } from "../actions";

export const metadata = { title: "Routine" };
export const dynamic = "force-dynamic";

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  on_time: { label: "Done on time", tone: "ok" },
  late: { label: "Done late", tone: "warn" },
  partly: { label: "Partly", tone: "warn" },
  missed: { label: "Missed", tone: "risk" },
  open: { label: "Open", tone: "info" },
};

export default async function RoutinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getPageContext();
  if (!canManageRoutines(ctx)) notFound();
  let view;
  try {
    view = await getRoutine(ctx, id);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "not_found") notFound();
    throw err;
  }
  const [runs, options] = await Promise.all([listRoutineRuns(ctx, id), routineFormOptions(ctx)]);
  const r = view.routine;
  const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: r.timezone });
  const initial: RoutineFormValues = {
    id: r.id,
    title: r.title,
    description: r.description,
    companyId: r.companyId ?? "",
    assignee: r.assigneePersonId ? `person:${r.assigneePersonId}` : `user:${r.assigneeUserId}`,
    scheduleKind: r.scheduleKind === "monthly" ? "monthly" : "weekly",
    days: r.days ?? [],
    monthDay: r.monthDay ? String(r.monthDay) : "",
    time: r.time,
    confirmation: r.confirmation === "checklist" ? "checklist" : "button",
    items: r.items.map((i) => i.label).join("\n"),
    chase: view.override,
  };
  const c = view.chase;
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/routines" className="hover:underline">
            Routines
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            {r.title}
            <Tag tone={r.status === "active" ? "ok" : r.status === "paused" ? "warn" : "neutral"}>{r.status}</Tag>
          </span>
        }
        actions={
          <>
            {r.status === "active" && (
              <ActionForm action={runRoutineNowAction}>
                <input type="hidden" name="id" value={r.id} />
                <button type="submit" className="btn btn-primary">
                  Run now
                </button>
              </ActionForm>
            )}
            {r.status !== "archived" && (
              <ActionForm action={setRoutineStatusAction}>
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="status" value={r.status === "active" ? "paused" : "active"} />
                <button type="submit" className="btn">
                  {r.status === "active" ? "Pause" : "Resume"}
                </button>
              </ActionForm>
            )}
            <ActionForm action={setRoutineStatusAction}>
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="status" value={r.status === "archived" ? "active" : "archived"} />
              <button type="submit" className="btn">
                {r.status === "archived" ? "Restore" : "Archive"}
              </button>
            </ActionForm>
            {runs.length === 0 && (
              <ActionForm action={deleteRoutineAction}>
                <input type="hidden" name="id" value={r.id} />
                <button type="submit" className="btn text-risk">
                  Delete
                </button>
              </ActionForm>
            )}
          </>
        }
      >
        <p className="mt-1 text-[13px] text-muted">
          {view.assigneeName}
          {view.assigneeKind === "founder" ? " (founder, own channel and rules)" : " (Telegram, Russian)"} · {view.scheduleText}
          {view.companyName ? ` · ${view.companyName}` : " · group-wide"} · remind every {c.chaseEveryMinutes} min until {c.chaseUntil}, at most{" "}
          {c.maxPerDay}/day · tell the founders {c.escalateAt ? `at ${c.escalateAt}` : ""}
          {c.escalateAt && c.escalateAfterChases ? " or " : ""}
          {c.escalateAfterChases ? `after ${c.escalateAfterChases} reminders` : ""}
          {!c.escalateAt && !c.escalateAfterChases ? "never" : ""}
        </p>
        {view.assigneeKind === "person" && !view.reachable && (
          <p className="mt-1 text-[12px] text-warn">
            The bot may not message {view.assigneeName} now, so runs do not open. Invite them / switch them on in{" "}
            <Link href="/settings/team-telegram" className="underline">
              Team on Telegram
            </Link>
            .
          </p>
        )}
      </PageHeader>

      <Section title="Run history" count={runs.length}>
        {runs.length === 0 ? (
          <p className="card px-4 py-4 text-[13px] text-muted">No runs yet. The first opens on the next scheduled day at {r.time}, or press Run now.</p>
        ) : (
          <ul className="card divide-y divide-line" aria-label="Run history">
            {runs.map(({ run, outcome, missing }) => (
              <li key={run.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]" data-testid="routine-run">
                <span className="num w-[90px]">{formatDisplayDate(run.runDate)}</span>
                <Tag tone={OUTCOME[outcome]!.tone}>{run.status === "escalated" ? "Open · founders told" : OUTCOME[outcome]!.label}</Tag>
                {run.items.length > 0 && (
                  <span className="text-muted">
                    {run.itemsDone.length}/{run.items.length} ticked{missing.length ? ` · missing: ${missing.join(", ")}` : ""}
                  </span>
                )}
                <span className="ml-auto text-[12px] text-muted">
                  asked {fmt.format(run.startedAt)}
                  {run.doneAt ? ` · done ${fmt.format(run.doneAt)}` : ""}
                  {run.chaseCount ? ` · ${run.chaseCount} reminder${run.chaseCount === 1 ? "" : "s"}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {r.status !== "archived" && (
        <Section title="Edit">
          <RoutineForm action={updateRoutineAction} initial={initial} options={{ ...options, defaults: view.assigneeKind === "person" ? view.defaults : options.defaults }} submitLabel="Save routine" />
        </Section>
      )}
    </>
  );
}
