import Link from "next/link";
import { InitialsAvatar, Tag, type Tone } from "@/components/ui";
import type { TaskFormOptions } from "@/server/services/options";
import type { TeamCounts, TeamGroup, TeamTelegramStatus } from "@/server/services/team-tasks";
import { TaskList } from "./TaskList";
import { toTaskItem } from "./types";

export const TELEGRAM_LABEL: Record<TeamTelegramStatus, { label: string; tone: Tone; title: string }> = {
  on: { label: "Telegram on", tone: "ok", title: "Linked and the bot may message them" },
  paused: { label: "Telegram paused", tone: "warn", title: "Linked, but paused for now" },
  linked: { label: "Telegram linked", tone: "info", title: "Linked; the bot may not message them yet (switch it on)" },
  invited: { label: "Invited", tone: "neutral", title: "Invite sent; waiting for them to press Start" },
  stopped: { label: "Telegram stopped", tone: "warn", title: "They sent /stop" },
  not_linked: { label: "Not linked", tone: "neutral", title: "Not on Telegram yet" },
};

/** Shown when the Team view read only its first `limit` tasks (TEAM_TASKS_LIMIT): groups and counts are partial. */
export function TeamCapNotice({ capped, limit }: { capped: boolean; limit: number }) {
  if (!capped) return null;
  return (
    <p role="status" data-testid="team-capped" className="card mb-3 px-4 py-2 text-[13px] text-risk">
      Showing the first <span className="num">{limit}</span> tasks only (counts too) — narrow the filters (company, person, status) to
      see the rest.
    </p>
  );
}

/** Counts line of a group: open, overdue (red), due today, waiting, done in the last 7 days. */
export function TeamCountsLine({ counts }: { counts: TeamCounts }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted" data-testid="team-counts">
      <Tag>
        <span className="num" data-count="open">{counts.open}</span> open
      </Tag>
      <Tag tone={counts.overdue > 0 ? "risk" : "neutral"}>
        <span className="num" data-count="overdue">{counts.overdue}</span> overdue
      </Tag>
      <Tag tone={counts.dueToday > 0 ? "warn" : "neutral"}>
        <span className="num" data-count="dueToday">{counts.dueToday}</span> due today
      </Tag>
      <Tag>
        <span className="num" data-count="waiting">{counts.waiting}</span> waiting
      </Tag>
      <Tag tone={counts.doneRecent > 0 ? "ok" : "neutral"}>
        <span className="num" data-count="doneRecent">{counts.doneRecent}</span> done · 7d
      </Tag>
    </p>
  );
}

/** The Team view: one section per founder / person (+ Unassigned). Columns on wide screens, stacked on a phone. */
export function TeamBoard({
  groups,
  today,
  options,
}: {
  groups: TeamGroup[];
  today: string;
  options: TaskFormOptions;
}) {
  if (groups.length === 0) {
    return <div className="card px-4 py-6 text-center text-[13px] text-muted">Nobody matches these filters.</div>;
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="team-board">
      {groups.map((g) => (
        <section key={g.key} className="min-w-0" aria-labelledby={`team-${g.key}`} data-testid="team-group" data-group={g.key}>
          <header className="mb-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {g.kind !== "unassigned" && <InitialsAvatar name={g.name} size={22} />}
              <h2 id={`team-${g.key}`} className="text-[15px] font-semibold">
                {g.personId ? (
                  <Link href={`/people/${g.personId}`} className="hover:underline">
                    {g.name}
                  </Link>
                ) : (
                  g.name
                )}
              </h2>
              {g.kind === "user" && <Tag>Founder</Tag>}
              {g.left && <Tag tone="warn">Left</Tag>}
              {g.telegram && (
                <span data-testid="team-telegram" data-state={g.telegram}>
                  <Tag tone={TELEGRAM_LABEL[g.telegram].tone} title={TELEGRAM_LABEL[g.telegram].title}>
                    {TELEGRAM_LABEL[g.telegram].label}
                  </Tag>
                </span>
              )}
            </div>
            <TeamCountsLine counts={g.counts} />
          </header>
          <TaskList
            tasks={g.tasks.map(toTaskItem)}
            today={today}
            options={options}
            empty={g.kind === "unassigned" ? "No unassigned tasks." : "No tasks match."}
          />
        </section>
      ))}
    </div>
  );
}
