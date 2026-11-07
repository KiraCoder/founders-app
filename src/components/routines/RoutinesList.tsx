import Link from "next/link";
import { CompanyDot, Tag, type Tone } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { formatDisplayDate, todayInTimeZone } from "@/lib/dates";
import { runProgress } from "@/lib/routines";
import type { RoutineView } from "@/server/services/routines";
import { RoutineActions } from "./RoutineActions";
import { RoutineAssigneeMenu, RoutineStatusIcon, RoutineStatusMenu, type RoutineAssigneeOption } from "./RoutineInline";
import { RoutineStatusScope, RoutineStatusTag } from "./RoutineStatus";
import { STATUS_LABEL } from "./status";
import { routineFormValues, todayRunOf, type RoutineFormOptions } from "./form-values";

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

export type RoutineGrouping = "status" | "assignee" | "company" | "none";
const STATUS_ORDER = ["active", "paused", "ended", "archived"];

/** Who can do routines (founders + people), for the inline assignee menu. */
export function routineAssigneeOptions(options: RoutineFormOptions): RoutineAssigneeOption[] {
  return [
    ...options.founders.map((f) => ({ value: `user:${f.id}`, label: f.name, group: "Founders" as const })),
    ...options.people.map((p) => ({ value: `person:${p.id}`, label: p.name, group: "Team" as const, companyIds: p.companyIds })),
  ];
}

/**
 * Routines, the same look as the task list (0034): rows grouped by status (Active / Paused /
 * Ended / Archived) under collapsible headers, our routine icon as the status (click: change it),
 * the assignee's avatar (click: reassign), company, schedule + next ask, the latest run's result,
 * and the icon actions (Run now, Edit, Pause, Archive …). With `options` the ✎ Edit opens the
 * dialog in place and the inline menus work; without, it is read-only and opens the page.
 */
export function RoutinesList({
  items,
  empty = "No routines yet.",
  options,
  now = new Date(),
  group = "none",
}: {
  items: RoutineView[];
  empty?: string;
  options?: RoutineFormOptions;
  now?: Date;
  group?: RoutineGrouping;
}) {
  if (!items.length) return <p className="card px-4 py-4 text-[13px] text-muted">{empty}</p>;
  const people = options ? routineAssigneeOptions(options) : null;
  const groups: { key: string; label: string; icon: React.ReactNode; items: RoutineView[] }[] = [];
  const add = (key: string, label: string, icon: React.ReactNode, v: RoutineView) => {
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, label, icon, items: [] }));
    g.items.push(v);
  };
  for (const v of items) {
    if (group === "status") add(v.status, STATUS_LABEL[v.status] ?? v.status, <RoutineStatusIcon status={v.status} size={14} />, v);
    else if (group === "assignee") add(v.routine.assigneePersonId ?? v.routine.assigneeUserId ?? "none", v.assigneeName, null, v);
    else if (group === "company") add(v.routine.companyId ?? "none", v.companyName ?? "Group-wide", null, v);
    else add("all", "All", null, v);
  }
  if (group === "status") groups.sort((a, b) => STATUS_ORDER.indexOf(a.key) - STATUS_ORDER.indexOf(b.key));
  else if (group !== "none") groups.sort((a, b) => a.label.localeCompare(b.label));

  const rows = (list: RoutineView[]) => (
    <ul className="divide-y divide-line" aria-label="Routines">
      {list.map((v) => {
        const r = v.routine;
        const assignee = r.assigneePersonId ? `person:${r.assigneePersonId}` : `user:${r.assigneeUserId}`;
        return (
          <RoutineStatusScope key={r.id} status={v.status}>
            <li data-testid="routine-row" className="group flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 hover:bg-sunk/50 sm:px-3">
              <div className="flex min-w-0 flex-[1_1_220px] items-center gap-1.5">
                {options ? <RoutineStatusMenu id={r.id} status={v.status} title={r.title} /> : <RoutineStatusIcon status={v.status} />}
                <Link href={`/routines/${r.id}`} className="min-w-0 truncate text-[13.5px] hover:underline">
                  {r.title}
                </Link>
                {group !== "status" && (
                  <span className="hidden sm:inline-flex">
                    <RoutineStatusTag status={v.status} />
                  </span>
                )}
                {v.assigneeKind === "person" && !v.reachable && v.status === "active" && (
                  <Tag tone="warn" title="Runs open only while the bot may message them (Settings → Team on Telegram)">
                    Not reachable on Telegram
                  </Tag>
                )}
                {v.commentsCount > 0 && (
                  <span className="num hidden items-center gap-0.5 text-[11.5px] text-muted sm:inline-flex" aria-label={`${v.commentsCount} comments`}>
                    <Icon name="comment" size={12} /> {v.commentsCount}
                  </span>
                )}
              </div>
              <div className="flex min-w-0 basis-full flex-wrap items-center justify-end gap-x-2 gap-y-1 pl-7 text-[12px] text-muted sm:ml-auto sm:basis-auto sm:pl-0">
                {v.companyName && (
                  <span className="hidden items-center gap-1 md:inline-flex">
                    <CompanyDot color="var(--muted)" size={6} />
                    {v.companyName}
                  </span>
                )}
                <span className="hidden lg:inline">{v.scheduleText}</span>
                {r.confirmation === "checklist" && <span className="hidden xl:inline">{r.items.length} items</span>}
                {v.status === "active" && <span className="num">next {formatNextDue(v.nextDueAt, r.timezone, now)}</span>}
                {r.endsOn && <span className="hidden md:inline">until {formatDisplayDate(r.endsOn)}</span>}
                {lastRunTag(v)}
                {people ? (
                  <RoutineAssigneeMenu id={r.id} title={r.title} assignee={assignee} name={v.assigneeName} companyId={r.companyId} options={people} disabled={v.status === "archived"} />
                ) : (
                  <span>
                    {v.assigneeName}
                    {v.assigneeKind === "founder" ? " (founder)" : ""}
                  </span>
                )}
                <RoutineActions
                  data={{ id: r.id, title: r.title, status: v.status, todayStatus: v.today?.status ?? null, hasRuns: !!v.lastRun, commentsCount: v.commentsCount }}
                  edit={options ? { initial: routineFormValues(v), today: todayRunOf(v), options } : null}
                />
              </div>
            </li>
          </RoutineStatusScope>
        );
      })}
    </ul>
  );

  if (group === "none") return <div className="card overflow-hidden">{rows(items)}</div>;
  return (
    <div className="card overflow-hidden">
      {groups.map((g) => (
        <details key={g.key} open={g.key !== "archived"} className="group/d" data-group={g.key}>
          <summary className="flex h-9 cursor-pointer list-none items-center gap-2 border-b border-line bg-sunk/80 px-3 text-[13px] [&::-webkit-details-marker]:hidden" data-testid="group-header">
            <span className="text-muted transition-transform group-[:not([open])]/d:-rotate-90" aria-hidden="true">
              <Icon name="chevronDown" size={14} />
            </span>
            {g.icon}
            <span className="font-semibold">{g.label}</span>
            <span className="num text-muted">{g.items.length}</span>
          </summary>
          {rows(g.items)}
        </details>
      ))}
    </div>
  );
}
