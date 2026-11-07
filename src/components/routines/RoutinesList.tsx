import Link from "next/link";
import { Tag, type Tone } from "@/components/ui";
import type { RoutineView } from "@/server/services/routines";

const RUN_TONE: Record<string, Tone> = { open: "info", escalated: "risk", done: "ok", partly: "warn", missed: "risk" };
const STATUS_TONE: Record<string, Tone> = { active: "ok", paused: "warn", archived: "neutral" };

/** A compact list of routines (Routines page, company page, person page). */
export function RoutinesList({ items, empty = "No routines yet." }: { items: RoutineView[]; empty?: string }) {
  if (!items.length) return <p className="card px-4 py-4 text-[13px] text-muted">{empty}</p>;
  return (
    <ul className="card divide-y divide-line" aria-label="Routines">
      {items.map((v) => {
        const r = v.routine;
        const left = v.today ? v.today.items.length - v.today.itemsDone.length : 0;
        return (
          <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-[13px]" data-testid="routine-row">
            <Link href={`/routines/${r.id}`} className="font-semibold hover:underline">
              {r.title}
            </Link>
            <span className="text-muted">
              {v.assigneeName}
              {v.assigneeKind === "founder" ? " (founder)" : ""} · {v.scheduleText}
              {v.companyName ? ` · ${v.companyName}` : ""}
              {r.confirmation === "checklist" ? ` · ${r.items.length} items` : ""}
            </span>
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              {v.today && (
                <Tag tone={RUN_TONE[v.today.status]}>
                  Today: {v.today.status}
                  {v.today.status !== "done" && r.confirmation === "checklist" ? ` (${left} left)` : ""}
                </Tag>
              )}
              {v.assigneeKind === "person" && !v.reachable && r.status === "active" && (
                <Tag tone="warn" title="Runs open only while the bot may message them (Settings → Team on Telegram)">
                  Not reachable on Telegram
                </Tag>
              )}
              <Tag tone={STATUS_TONE[r.status]}>{r.status}</Tag>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
