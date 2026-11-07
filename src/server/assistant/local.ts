import "server-only";
import type { ServiceContext } from "@/server/services/context";
import { listTasks, type TaskView } from "@/server/services/tasks";
import { listRoutines } from "@/server/services/routines";
import { pickOne, normalizeName } from "@/server/mcp/resolve";
import { toolErrorMessage } from "@/server/mcp/registry";

/**
 * Simple commands answered without calling the model (free, instant, work without a key):
 * /help, /tasks, /overdue, /routines, /routine <name>. Also the plain words "overdue",
 * "просрочено", "my tasks", "мои задачи".
 */

const SHORT_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const short = (iso: string) => SHORT_DATE.format(new Date(`${iso}T00:00:00Z`));
const MAX_LINES = 15;

function taskLines(rows: TaskView[], base: string): string {
  const lines = rows.slice(0, MAX_LINES).map((t) => {
    const bits = [t.assignee?.name, t.dueDate ? short(t.dueDate) : null, t.company?.name].filter(Boolean).join(" · ");
    return `• [${t.title}](${base}/tasks/${t.id})${bits ? ` — ${bits}` : ""}`;
  });
  if (rows.length > MAX_LINES) lines.push(`…and ${rows.length - MAX_LINES} more`);
  return lines.join("\n");
}

export const HELP = [
  "Ask me anything about tasks, projects, people and routines, in English, Russian or Kyrgyz. I show a card before saving anything.",
  "Quick commands (no AI needed):",
  "/tasks — my open tasks",
  "/overdue — overdue tasks",
  "/routines — today's routines",
  "/routine <name> — one routine",
].join("\n");

type Cmd = { cmd: "help" | "tasks" | "overdue" | "routines" } | { cmd: "routine"; arg: string };

export function parseLocalCommand(text: string): Cmd | null {
  const t = text.trim();
  const n = normalizeName(t);
  if (/^\/(help|\?)$/i.test(t) || n === "help" || n === "помощь") return { cmd: "help" };
  if (/^\/tasks$/i.test(t) || ["my tasks", "мои задачи", "менин тапшырмаларым"].includes(n)) return { cmd: "tasks" };
  if (/^\/overdue$/i.test(t) || ["overdue", "просрочено", "просроченные", "просрочка", "кечиккендер"].includes(n)) return { cmd: "overdue" };
  if (/^\/routines$/i.test(t)) return { cmd: "routines" };
  const m = /^(?:\/routine|open routine)\s+(.+)$/i.exec(t);
  if (m) return { cmd: "routine", arg: m[1]!.trim() };
  return null;
}

export async function runLocalCommand(ctx: ServiceContext, c: Cmd, base: string): Promise<string> {
  try {
    switch (c.cmd) {
      case "help":
        return HELP;
      case "tasks": {
        const [assigned, todos] = await Promise.all([listTasks(ctx, { view: "assigned", status: "open", limit: 200 }), listTasks(ctx, { view: "my", status: "open", limit: 200 })]);
        const rows = [...new Map([...assigned, ...todos].map((t) => [t.id, t])).values()];
        return rows.length ? `Your open tasks (${rows.length}):\n${taskLines(rows, base)}` : "No open tasks for you.";
      }
      case "overdue": {
        const rows = await listTasks(ctx, { view: "overdue", status: "open", limit: 200 });
        return rows.length ? `Overdue (${rows.length}):\n${taskLines(rows, base)}` : "Nothing is overdue.";
      }
      case "routines": {
        const rows = await listRoutines(ctx, { status: "active" });
        if (!rows.length) return "No active routines.";
        const lines = rows.slice(0, MAX_LINES).map((v) => {
          const run = v.today;
          const state = !run ? "not asked yet" : run.status === "done" ? "done ✓" : run.items.length ? `${run.itemsDone.length}/${run.items.length} ticked` : run.status;
          return `• [${v.routine.title}](${base}/routines/${v.routine.id}) — ${v.assigneeName}: ${state}`;
        });
        return `Routines today:\n${lines.join("\n")}`;
      }
      case "routine": {
        const rows = await listRoutines(ctx, { status: "all" });
        const v = pickOne(c.arg, rows.map((x) => ({ value: x, label: x.routine.title, keys: [x.routine.id, normalizeName(x.routine.title)] })), "routine");
        const run = v.today;
        const done = new Set(run?.itemsDone ?? []);
        const missing = run ? run.items.filter((i) => !done.has(i.key)).map((i) => i.label) : [];
        return [
          `[${v.routine.title}](${base}/routines/${v.routine.id}) — ${v.assigneeName}${v.companyName ? `, ${v.companyName}` : ""}`,
          `${v.scheduleText} · ${v.routine.status}`,
          `Today: ${!run ? "not asked yet" : run.status === "done" ? "done ✓" : missing.length ? `missing ${missing.join(", ")}` : run.status}`,
        ].join("\n");
      }
    }
  } catch (err) {
    return toolErrorMessage(err, "assistant");
  }
}
