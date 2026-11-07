/**
 * AI role editor ("tune AI inside the cockpit"): the pure, code-defined parts of a role's
 * editable settings — schedule kinds, the rule-check catalogue per engine (each check on/off
 * with its own thresholds), the role identity a founder can rename / rewrite, custom ratio
 * checks and the Zod schemas for all of it.
 *
 * Defaults reproduce the behaviour from before the editor exactly (tested): a hire or role
 * without saved checks analyses the same way and keeps its report hashes.
 *
 * Pure (no DB, no clock). Imported by src/lib/ai-roles.ts (which re-exports the schedule).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export type Schedule =
  /** Day of the month the role runs for the month that just finished (1–28). */
  | { kind: "monthly"; day: number }
  /** ISO weekday (1 = Monday … 7 = Sunday). Run roles: the first such weekday of the month. */
  | { kind: "weekly"; weekday: number }
  /** No scheduled runs or summary lines (Run now still works). */
  | { kind: "off" };

export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("monthly"), day: z.coerce.number().int().min(1).max(28) }).strict(),
  z.object({ kind: z.literal("weekly"), weekday: z.coerce.number().int().min(1).max(7) }).strict(),
  z.object({ kind: z.literal("off") }).strict(),
]);

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// ---------------------------------------------------------------------------
// Engines and the rule-check catalogue
// ---------------------------------------------------------------------------

/**
 * finance   — monthly runs over company numbers (the Financial Analyst);
 * org_rules — live checks of the company's org chart, one summary line on schedule;
 * custom    — a founder-made role: monthly runs over the numbers it watches, generic checks.
 */
export type RoleEngine = "finance" | "org_rules" | "custom";

/** Engines that make monthly runs / reports (the same run → report → push pipeline). */
export const runBased = (e: RoleEngine): boolean => e === "finance" || e === "custom";

export interface CheckParam {
  key: string;
  label: string;
  unit: "%" | "months" | "departments" | "tasks";
  min: number;
  max: number;
  /** Default value; null = "same as …" (see `nullLabel`). */
  default: number | null;
  /** May be left empty: what an empty value means. */
  nullLabel?: string;
}

export interface CheckDef {
  id: string;
  label: string;
  help: string;
  defaultEnabled: boolean;
  params: CheckParam[];
}

const changePrev: CheckDef = {
  id: "change_prev",
  label: "Change vs the month before",
  help: "A number moved by at least the warning % vs the month before (risk past the risk %; a good direction is info).",
  defaultEnabled: true,
  params: [
    { key: "warnPct", label: "Warn at (%)", unit: "%", min: 1, max: 500, default: 20 },
    { key: "riskPct", label: "Risk at (%)", unit: "%", min: 1, max: 1000, default: 50 },
  ],
};
const changeAvg: CheckDef = {
  id: "change_avg",
  label: "Change vs the 3-month average",
  help: "The same check against the average of the 3 months before.",
  defaultEnabled: true,
  params: [
    { key: "warnPct", label: "Warn at (%)", unit: "%", min: 1, max: 500, default: null, nullLabel: "same as vs the month before" },
    { key: "riskPct", label: "Risk at (%)", unit: "%", min: 1, max: 1000, default: null, nullLabel: "same as vs the month before" },
  ],
};
const missing: CheckDef = {
  id: "missing",
  label: "Missing numbers",
  help: "Numbers without a value for 2+ months (warning) and numbers never entered (info).",
  defaultEnabled: true,
  params: [],
};
const target: CheckDef = {
  id: "target",
  label: "Target missed",
  help: "The month missed the number's target (risk when off by the risk % or more).",
  defaultEnabled: true,
  params: [],
};

export const CHECK_CATALOGUE: Record<RoleEngine, CheckDef[]> = {
  finance: [
    changePrev,
    changeAvg,
    {
      id: "ratios",
      label: "Ratios",
      help: "Revenue per order, piecework pay per piece, returns rate, shipment error rate — month over month, with the thresholds of “vs the month before”.",
      defaultEnabled: true,
      params: [],
    },
    {
      id: "cod_payout",
      label: "COD paid out vs collected",
      help: "The share of COD collected that was paid out to shops is too low.",
      defaultEnabled: true,
      params: [
        { key: "warnBelowPct", label: "Warn below (%)", unit: "%", min: 0, max: 100, default: null, nullLabel: "100 − the warning %" },
        { key: "riskBelowPct", label: "Risk below (%)", unit: "%", min: 0, max: 100, default: null, nullLabel: "100 − the risk %" },
      ],
    },
    {
      id: "defect_max",
      label: "Defect rate ceiling",
      help: "Defect rate above this % in the month (on top of the number's target).",
      defaultEnabled: false,
      params: [{ key: "maxPct", label: "Max defects (%)", unit: "%", min: 0, max: 100, default: 3 }],
    },
    {
      id: "debt_trend",
      label: "Intercompany debt growing",
      help: "The Holding's intercompany debt grew this many months in a row.",
      defaultEnabled: true,
      params: [{ key: "months", label: "Months in a row", unit: "months", min: 2, max: 6, default: 3 }],
    },
    target,
    missing,
  ],
  org_rules: [
    { id: "division_no_head", label: "Division without a head", help: "", defaultEnabled: true, params: [] },
    { id: "department_no_head", label: "Department without a head", help: "", defaultEnabled: true, params: [] },
    {
      id: "head_overloaded",
      label: "One person heads too many departments",
      help: "",
      defaultEnabled: true,
      params: [{ key: "maxDepartments", label: "More than … departments", unit: "departments", min: 1, max: 21, default: 4 }],
    },
    { id: "department_no_ckp", label: "Department without ЦКП", help: "", defaultEnabled: true, params: [] },
    { id: "department_no_statistic", label: "Department without a statistic", help: "", defaultEnabled: true, params: [] },
    { id: "metric_stale", label: "Linked number not up to date", help: "", defaultEnabled: true, params: [] },
    {
      id: "overdue_tasks",
      label: "Department with overdue tasks",
      help: "",
      defaultEnabled: true,
      params: [{ key: "minTasks", label: "At least … overdue tasks", unit: "tasks", min: 1, max: 100, default: 5 }],
    },
    { id: "function_no_responsible", label: "Function without a responsible person (info)", help: "", defaultEnabled: true, params: [] },
  ],
  custom: [changePrev, changeAvg, missing, target],
};

/** One check's saved settings: on/off plus its parameters (null = the default meaning). */
export type CheckSetting = { enabled: boolean } & Record<string, number | boolean | null>;
export type ChecksConfig = Record<string, CheckSetting>;

export const checksSchema = z.record(
  z.string().trim().min(1).max(60),
  z.object({ enabled: z.boolean() }).catchall(z.union([z.number(), z.null(), z.boolean()])),
);

/** The catalogue's defaults for an engine (today's behaviour). */
export function defaultChecks(engine: RoleEngine): ChecksConfig {
  const out: ChecksConfig = {};
  for (const c of CHECK_CATALOGUE[engine]) {
    const s: CheckSetting = { enabled: c.defaultEnabled };
    for (const p of c.params) s[p.key] = p.default;
    out[c.id] = s;
  }
  return out;
}

export class ChecksError extends Error {}

/**
 * Validates saved checks against the engine's catalogue and fills what is not set with the
 * defaults. Unknown checks / parameters and values out of range are refused (ChecksError).
 */
export function normalizeChecks(engine: RoleEngine, raw: unknown): ChecksConfig {
  const parsed = raw === undefined || raw === null ? {} : checksSchema.parse(raw);
  const out = defaultChecks(engine);
  for (const [id, setting] of Object.entries(parsed)) {
    const def = CHECK_CATALOGUE[engine].find((c) => c.id === id);
    if (!def) throw new ChecksError(`Unknown check: ${id}`);
    const s: CheckSetting = { ...out[id]!, enabled: setting.enabled };
    for (const [k, v] of Object.entries(setting)) {
      if (k === "enabled") continue;
      const p = def.params.find((x) => x.key === k);
      if (!p) throw new ChecksError(`Unknown setting ${k} of ${def.label}`);
      if (v === null) {
        if (p.default !== null) throw new ChecksError(`${def.label}: ${p.label} is required`);
        s[k] = null;
        continue;
      }
      if (typeof v !== "number" || !Number.isInteger(v) || v < p.min || v > p.max) {
        throw new ChecksError(`${def.label}: ${p.label} must be a whole number from ${p.min} to ${p.max}`);
      }
      s[k] = v;
    }
    out[id] = s;
  }
  for (const def of CHECK_CATALOGUE[engine]) {
    const s = out[def.id]!;
    const warn = s.warnPct;
    const risk = s.riskPct;
    if (typeof warn === "number" && typeof risk === "number" && risk < warn) {
      throw new ChecksError(`${def.label}: the risk % must be at least the warning %`);
    }
    const wb = s.warnBelowPct;
    const rb = s.riskBelowPct;
    if (typeof wb === "number" && typeof rb === "number" && rb > wb) {
      throw new ChecksError(`${def.label}: “risk below” must be at most “warn below”`);
    }
  }
  return out;
}

/** A canonical text of checks (sorted keys) — for comparisons and hashes. */
export function checksKey(c: ChecksConfig): string {
  return JSON.stringify(
    Object.keys(c)
      .sort()
      .map((id) => [id, Object.keys(c[id]!).sort().map((k) => [k, c[id]![k]])]),
  );
}

// ---------------------------------------------------------------------------
// Custom ratio checks (custom roles): "ratio between two chosen numbers with min/max"
// ---------------------------------------------------------------------------

/** Decimal text: 1234.5, -3, 0.25 (at most 4 decimals). */
const decimalText = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim().replace(",", "."))
  .refine((v) => /^-?\d{1,13}(\.\d{1,4})?$/.test(v), { message: "A number like 2000 or 0.25" });

export const ratioCheckSchema = z
  .object({
    id: z.string().trim().regex(/^[a-z0-9-]{1,40}$/),
    enabled: z.boolean().default(true),
    numeratorKey: z.string().trim().min(1).max(60),
    denominatorKey: z.string().trim().min(1).max(60),
    /** × 100 (a share in %), otherwise the plain ratio. */
    percent: z.boolean().default(false),
    min: z.preprocess((v) => (v === "" || v === undefined ? null : v), decimalText.nullable()),
    max: z.preprocess((v) => (v === "" || v === undefined ? null : v), decimalText.nullable()),
  })
  .strict()
  .refine((r) => r.min !== null || r.max !== null, { message: "Give a minimum, a maximum or both", path: ["min"] })
  .refine((r) => r.numeratorKey !== r.denominatorKey, { message: "Choose two different numbers", path: ["denominatorKey"] })
  .refine((r) => r.min === null || r.max === null || Number(r.min) <= Number(r.max), { message: "The minimum must be at most the maximum", path: ["max"] });
export type RatioCheck = z.output<typeof ratioCheckSchema>;

// ---------------------------------------------------------------------------
// Role identity (name, job description, responsibilities, instructions)
// ---------------------------------------------------------------------------

const blankToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const profileSchema = z
  .object({
    name: z.preprocess(blankToUndef, z.string().trim().min(2).max(80).optional()),
    description: z.preprocess(blankToUndef, z.string().trim().max(1000).optional()),
    responsibilities: z.array(z.string().trim().min(1).max(300)).max(15).optional(),
    /**
     * "Your instructions" for the AI narrative (stored now; used once an AI provider is
     * chosen — never by the rule-based analysis).
     */
    instructions: z.preprocess(blankToUndef, z.string().trim().max(4000).optional()),
  })
  .strict();
export type RoleProfile = z.output<typeof profileSchema>;

/** Drops empty fields (an empty override = inherit). */
export function cleanProfile(p: RoleProfile | undefined): RoleProfile | undefined {
  if (!p) return undefined;
  const out: RoleProfile = {};
  if (p.name) out.name = p.name;
  if (p.description) out.description = p.description;
  if (p.responsibilities?.length) out.responsibilities = p.responsibilities;
  if (p.instructions) out.instructions = p.instructions;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Role-level settings (a built-in role's template edits, or a custom role's definition)
// ---------------------------------------------------------------------------

export const roleConfigSchema = z
  .object({
    profile: profileSchema.optional(),
    /** Default schedule for new hires (and hires that never set one). */
    schedule: scheduleSchema.optional(),
    /** Default recipients for new hires (founders only). */
    recipients: z.array(z.uuid()).max(10).optional(),
    /** Check defaults for every hire of the role that did not override its checks. */
    checks: checksSchema.optional(),
    /** Custom roles: the numbers it watches (metric keys of its company). */
    watchedMetricKeys: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
    /** Custom roles: the watched numbers it waits for before it analyses (default: all watched). */
    requiredMetricKeys: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
    /** Custom roles: ratio checks between two watched numbers. */
    ratioChecks: z.array(ratioCheckSchema).max(10).optional(),
  })
  .strict();
export type RoleConfig = z.output<typeof roleConfigSchema>;

export const customRoleCreateSchema = z
  .object({
    companyId: z.uuid(),
    /** Copy a built-in role's identity, schedule and generic checks (null = from scratch). */
    copyFrom: z.preprocess((v) => (v === "" ? null : v), z.string().trim().max(60).nullable().optional()),
    config: roleConfigSchema,
  })
  .strict();
export type CustomRoleCreateInput = z.input<typeof customRoleCreateSchema>;
