import Link from "next/link";
import { Tag, type Tone } from "@/components/ui";
import { formatDisplayDate, todayInTimeZone } from "@/lib/dates";
import { runProgress } from "@/lib/routines";
import type { RoutineView } from "@/server/services/routines";
import { RoutineActions } from "./RoutineActions";
import { routineFormValues, todayRunOf, type RoutineFormOptions } from "./form-values";

export const STATUS_TONE: Record<string, Tone> = { active: "ok", paused: "warn", ended: "neutral", archived: "neutral" };
export const STATUS_LABEL: Record<string, string> = { active: "Active", paused: "Paused", ended: "Ended", archived: "Archived" };
const RUN_TONE: Record<string, Tone> = { open: "info", escalated: "risk", done: "ok", partly: "warn", missed: "risk" };
const RUN_LABEL: Record<string, string> = { open: "open", escalated: "open · founders told", done: "done", partly: "partly", missed: "missed" };

/** "today 15:00" / "Tue 15:00" / "12.11 10:00" in the routine's time zone. */
export function formatNextDue(at: Date | null, tz: string, now: Date): string {
  if (!at) return "—";
  const day = todayInTimeZone(at, tz);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(at);
  const today = todayInTimeZone(now, tz);
  if (day === today) return `today ${time}`;
  const diff = (Date.parse(day) - Date.parse(today)) / 86_400_000;
  if (diff > 0 && diff < 7) return `${new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: tz }).format(at)} ${time}`;
  return `${formatDisplayDate(day).slice(0, 5)} ${time}`;
}

function lastRunTag(v: RoutineView) {
  const run = v.today ?? v.lastRun;
  if (!run) return <span className="text-[12px] text-muted">No runs yet</span>;
  const p = runProgress(run);
  const cant = Object.values(run.itemStates ?? {}).some((s) => s.state === "cant");
  const label = run.status === "done" ? "done" : cant && !["open", "escalated"].includes(run.status) ? "can't" : RUN_LABEL[run.status];
  const when = v.today ? "Today" : formatDisplayDate(run.runDate).slice(0, 5);
  return (
    <Tag tone={cant && run.status !== "done" ? "risk" : RUN_TONE[run.status]} title={`${when}: ${p.done} of ${p.total} done`}>
      {when} {p.done}/{p.total} · {label}
    </Tag>
  );
}

/**
 * Routines as a control center (Routines page, company page, person page): per row the status,
 * who, company, schedule + next ask, the latest run's result (3/5, missed), comments, and the
 * icon actions. With `options` the ✎ Edit opens the dialog in place; without, it opens the page.
 */
export function RoutinesList({
  items,
  empty = "No routines yet.",
  options,
  now = new Date(),
}: {
  items: RoutineView[];
  empty?: string;
  options?: RoutineFormOptions;
  now?: Date;
}) {
  if (!items.length) return <p className="card px-4 py-4 text-[13px] text-muted">{empty}</p>;
  return (
    <ul className="card divide-y divide-line" aria-label="Routines">
      {items.map((v) => {
        const r = v.routine;
        return (
          <li key={r.id} className="flex flex-col gap-2 px-4 py-3 text-[13px] md:flex-row md:items-center" data-testid="routine-row">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link href={`/routines/${r.id}`} className="font-semibold hover:underline">
                  {r.title}
                </Link>
                <Tag tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status] ?? v.status}</Tag>
                {v.assigneeKind === "person" && !v.reachable && v.status === "active" && (
                  <Tag tone="warn" title="Runs open only while the bot may message them (Settings → Team on Telegram)">
                    Not reachable on Telegram
                  </Tag>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
                <span>
                  {v.assigneeName}
                  {v.assigneeKind === "founder" ? " (founder)" : ""}
                </span>
                <span aria-hidden>·</span>
                <span>{v.companyName ?? "Group-wide"}</span>
                <span aria-hidden>·</span>
                <span>{v.scheduleText}</span>
                {r.confirmation === "checklist" && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{r.items.length} items</span>
                  </>
                )}
                {v.status === "active" && (
                  <>
                    <span aria-hidden>·</span>
                    <span>next {formatNextDue(v.nextDueAt, r.timezone, now)}</span>
                  </>
                )}
                {r.endsOn && <span>· until {formatDisplayDate(r.endsOn)}</span>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              {lastRunTag(v)}
              <RoutineActions
                data={{ id: r.id, title: r.title, status: v.status, todayStatus: v.today?.status ?? null, hasRuns: !!v.lastRun, commentsCount: v.commentsCount }}
                edit={options ? { initial: routineFormValues(v), today: todayRunOf(v), options } : null}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
