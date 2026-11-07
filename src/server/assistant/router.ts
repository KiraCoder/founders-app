import "server-only";
import { z } from "zod";
import { toolsFor } from "@/server/mcp/all-tools";
import type { AnyTool } from "@/server/mcp/registry";
import type { ChatTool } from "./openai";

/**
 * Which tools go to the model for a message (fewer tools = fewer input tokens), and how tool
 * results are shrunk before the model reads them.
 */

export const MAX_TOOLS = 8;

const ROUTINE_RE = /routin|checklist|check list|chek|чек|рутин|регуляр|каждый|кажд|ежеднев|еженед|по (понедельн|вторн|сред|четверг|пятниц|суббот|воскрес)|every (day|week|mon|tue|wed|thu|fri|sat|sun)|daily|weekly|monthly|күн сайын|ар күн|напомина|remind|1с|1c/i;
const PROJECT_RE = /project|проект|долбоор|план\b|plan\b/i;
const TASK_RE = /task|todo|to-do|задач|задан|тапшырма|иш\b|сдела|готов|выполн|done|finish|complete|коммент|comment|срок|дедлайн|deadline|due|overdue|просроч|кечик|assign|назнач|поручи/i;

const GROUPS = {
  base: ["list_tasks", "list_people"],
  tasks: ["add_tasks", "update_task", "complete_task", "add_task_comment", "get_project"],
  projects: ["list_projects", "get_project", "create_project", "add_tasks"],
  routines: ["list_routines", "get_routine", "create_routine", "update_routine"],
  fallback: ["list_routines", "list_projects", "get_project"],
} as const;

/** Tool names for this text (the founder's message plus a little recent context). */
export function routeTools(text: string): string[] {
  const names: string[] = [];
  const add = (xs: readonly string[]) => xs.forEach((x) => !names.includes(x) && names.push(x));
  const routines = ROUTINE_RE.test(text);
  const projects = PROJECT_RE.test(text);
  const tasks = TASK_RE.test(text);
  if (routines) add(GROUPS.routines);
  add(GROUPS.base);
  if (tasks) add(GROUPS.tasks);
  if (projects) add(GROUPS.projects);
  if (!routines && !projects && !tasks) add(GROUPS.fallback);
  return names.slice(0, MAX_TOOLS);
}

/** Shortens a description to its first sentence (≤ 70 chars). */
function brief(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const first = s.split(/(?<=\.)\s/)[0]!;
  return first.length > 70 ? `${first.slice(0, 67)}...` : first;
}

/** Lean JSON schema: no $schema, no additionalProperties noise, short descriptions. */
function lean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(lean);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$schema" || k === "additionalProperties" || k === "pattern" || k === "format") continue;
    if (k === "properties" && v && typeof v === "object") {
      // Property names are data (a field may be called "description"): keep them all.
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, s]) => [name, lean(s)]));
      continue;
    }
    if (k === "description" && typeof v === "string") {
      const b = brief(v as string);
      if (b) out[k] = b;
      continue;
    }
    if (k === "maxLength" || k === "minLength" || k === "maxItems") continue;
    out[k] = lean(v);
  }
  return out;
}

const schemaCache = new Map<string, ChatTool>();

export function chatTool(t: AnyTool): ChatTool {
  const hit = schemaCache.get(t.name);
  if (hit) return hit;
  const parameters = lean(z.toJSONSchema(z.object(t.input), { io: "input", unrepresentable: "any" })) as Record<string, unknown>;
  const tool: ChatTool = { type: "function", function: { name: t.name, description: t.brief, parameters } };
  schemaCache.set(t.name, tool);
  return tool;
}

export function assistantTools(names: string[]): { tools: AnyTool[]; chat: ChatTool[] } {
  const all = toolsFor("assistant");
  const tools = names.map((n) => all.find((t) => t.name === n)).filter((t): t is AnyTool => !!t);
  return { tools, chat: tools.map(chatTool) };
}

// ---------------------------------------------------------------------------
// Compact tool results
// ---------------------------------------------------------------------------

export const MAX_ROWS = 20;
const MAX_RESULT_CHARS = 6000;
const DROP_KEYS = new Set(["url", "short_name", "full_name"]);

function compact(v: unknown, depth: number): unknown {
  if (Array.isArray(v)) {
    const rows = v.slice(0, MAX_ROWS).map((x) => compact(x, depth + 1));
    return v.length > MAX_ROWS ? [...rows, `+${v.length - MAX_ROWS} more`] : rows;
  }
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue;
    if (x === null || x === undefined || x === false || x === "" || (Array.isArray(x) && x.length === 0)) continue;
    // Nested references ({id, name}) → just the name; ids are kept only on list rows.
    if (depth > 0 && x && typeof x === "object" && !Array.isArray(x) && "name" in x && "id" in x && Object.keys(x).length <= 3) {
      out[k] = (x as { name: unknown }).name;
      continue;
    }
    if (k === "priority" && x === "normal") continue;
    out[k] = compact(x, depth + 1);
  }
  return out;
}

/** A tool result as the model reads it: summary + compact JSON, capped. */
export function compactResult(summary: string, data: unknown): string {
  const firstLine = summary.split("\n")[0]!;
  const json = JSON.stringify(compact(data, 0));
  const text = `${firstLine}\n${json}`;
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (cut; ask narrower)` : text;
}
