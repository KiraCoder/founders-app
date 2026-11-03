/**
 * AI roles: the code-defined catalogue of roles ("templates") the founders can hire for a
 * company, the settings a hire is tuned with, and the pure scheduling / chasing rules.
 * `npm run db:seed` (and the hire service) copies the catalogue into `ai_role_templates`;
 * this file stays the source of truth.
 *
 * Pure (no DB, no clock): callers pass `today` (Asia/Bishkek calendar day).
 */
import { z } from "zod";
import { checksSchema, profileSchema, runBased, scheduleSchema, WEEKDAY_NAMES, type RoleEngine, type Schedule } from "./ai-role-config";
import { addDays, daysBetween, isoWeekday, type IsoDate } from "./dates";

export type { RoleEngine, Schedule } from "./ai-role-config";
export { runBased } from "./ai-role-config";

export type TemplateStatus = "available" | "coming_soon";

/**
 * Company "types" decide which numbers a role needs. The group's companies are mapped by
 * slug; a company that is not in the map is "other" (all its monthly numbers).
 */
export const COMPANY_TYPES = ["delivery", "garment_factory", "brand", "marketplace", "it_services", "holding", "marketing", "other"] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

export const COMPANY_TYPE_BY_SLUG: Record<string, CompanyType> = {
  "kiwi-go": "delivery",
  "alura-style": "garment_factory",
  "alura-brand": "brand",
  "upsell-group": "marketplace",
  jobutify: "it_services",
  "asqa-zou-holding": "holding",
  marketing: "marketing",
};

export const COMPANY_TYPE_LABELS: Record<CompanyType, string> = {
  delivery: "Delivery",
  garment_factory: "Garment factory",
  brand: "Clothing brand",
  marketplace: "Marketplace sales",
  it_services: "IT services",
  holding: "Holding",
  marketing: "Marketing",
  other: "Other",
};

export function companyTypeFor(slug: string): CompanyType {
  return COMPANY_TYPE_BY_SLUG[slug] ?? "other";
}

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  status: TemplateStatus;
  responsibilities: string[];
  /** Metric keys (src/lib/kpis.ts) the role needs, per company type. */
  requiredData: Partial<Record<CompanyType, string[]>>;
  /** Files it can use later (not required now). */
  optionalUploads: string[];
  defaultSchedule: Schedule;
  /** What every report contains. */
  reportSections: string[];
  sort: number;
  /**
   * How it works: "finance" = monthly runs over company numbers (the Financial Analyst's
   * engine, the default); "org_rules" = deterministic checks of the company's org chart,
   * shown live on the board and once a week (Mondays) in the morning summary — no runs;
   * "custom" = a founder-made role (services/ai-role-defs.ts), monthly runs with generic checks.
   */
  engine?: RoleEngine;
}

export const FINANCIAL_ANALYST = "financial-analyst";
export const ORG_STRUCTURE_EXPERT = "org-structure-expert";

/** Which engine a template runs on (finance unless stated). */
export function templateEngine(t: Pick<RoleTemplate, "engine"> | undefined): RoleEngine {
  return t?.engine ?? "finance";
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: FINANCIAL_ANALYST,
    name: "Financial Analyst",
    description:
      "The group has no financial director. Once a month it checks that each company's numbers for the finished month are in, chases the founders for what is missing, analyses them and reports what needs attention.",
    status: "available",
    responsibilities: [
      "Ask for the finished month's numbers on schedule and chase what is missing (inside the morning summary)",
      "Compare each number with the month before and with the 3-month average",
      "Check ratios: COD paid out vs collected, piecework pay per piece, returns rate, revenue per order",
      "Flag numbers missing for 2+ months, missed targets and intercompany debt growing 3 months in a row",
      "Send one “report ready” message per report to the founders who receive reports",
    ],
    requiredData: {
      delivery: ["revenue", "orders_day", "cod_collected", "cod_paid_out"],
      garment_factory: ["output_pcs", "piecework_total", "defect_pct"],
      brand: ["sales", "orders_to_factory"],
      marketplace: ["wb_sales", "wb_orders", "wb_returns"],
      it_services: ["wms_orders_day", "wms_shipment_errors"],
      holding: ["intercompany_debt"],
    },
    optionalUploads: ["Bank statement (PDF) — later", "Profit and loss from the accountant — later"],
    defaultSchedule: { kind: "monthly", day: 10 },
    reportSections: ["Risks", "Warnings", "Info", "Numbers used", "AI summary (after the AI provider is chosen)"],
    sort: 10,
  },
  {
    key: ORG_STRUCTURE_EXPERT,
    name: "Org Structure Expert",
    description:
      "Checks a company's org chart (Vysotsky model) every week: who heads what, missing ЦКП and statistics, stale linked numbers, departments drowning in overdue tasks. Brainstorming and advice come after the AI provider is chosen.",
    status: "available",
    engine: "org_rules",
    responsibilities: [
      "Flag divisions and departments without a head, and people heading too many departments",
      "Flag departments without a ЦКП or a statistic, and linked numbers that are not up to date",
      "Flag departments with 5+ overdue tasks; list functions without a responsible person (info)",
      "One grouped line in the Monday morning summary (only when something needs attention)",
      "Brainstorm the structure with you (after the AI provider is chosen)",
    ],
    requiredData: {},
    optionalUploads: [],
    defaultSchedule: { kind: "weekly", weekday: 1 },
    reportSections: ["Findings on the org board", "Monday summary line", "Advice (after the AI provider is chosen)"],
    sort: 15,
  },
  {
    key: "hr",
    name: "HR",
    description: "Headcount, hiring and people changes per company. Coming soon.",
    status: "coming_soon",
    responsibilities: ["Track headcount and staff turnover", "Remind about probation ends and contract renewals"],
    requiredData: { garment_factory: ["headcount"] },
    optionalUploads: [],
    defaultSchedule: { kind: "monthly", day: 5 },
    reportSections: ["Headcount", "Changes"],
    sort: 20,
  },
  {
    key: "marketing",
    name: "Marketing",
    description: "Campaign results and marketing spend across the group. Coming soon.",
    status: "coming_soon",
    responsibilities: ["Collect campaign results", "Compare spend with sales"],
    requiredData: {},
    optionalUploads: [],
    defaultSchedule: { kind: "monthly", day: 5 },
    reportSections: ["Campaigns", "Spend vs sales"],
    sort: 30,
  },
  {
    key: "operations",
    name: "Operations",
    description: "Daily operations: delivery times, factory output, shipment errors. Coming soon.",
    status: "coming_soon",
    responsibilities: ["Watch daily operations numbers", "Flag drops the same week"],
    requiredData: { delivery: ["orders_day", "on_time_pct"], garment_factory: ["output_pcs"] },
    optionalUploads: [],
    defaultSchedule: { kind: "monthly", day: 3 },
    reportSections: ["Operations"],
    sort: 40,
  },
];

export function templateByKey(key: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.key === key);
}

/** Metric keys the template needs for this company type (empty for none). */
export function requiredKeysFor(t: RoleTemplate, type: CompanyType): string[] {
  return t.requiredData[type] ?? [];
}

// ---------------------------------------------------------------------------
// Hire settings ("tune once, then it runs")
// ---------------------------------------------------------------------------

export const DEFAULT_THRESHOLDS = { changePct: 20, riskChangePct: 50 } as const;

const pct = (max: number) => z.coerce.number().int().min(1).max(max);

export const hireSettingsSchema = z
  .object({
    schedule: scheduleSchema,
    thresholds: z
      .object({ changePct: pct(500), riskChangePct: pct(1000) })
      .strict()
      .refine((t) => t.riskChangePct >= t.changePct, { message: "The risk threshold must be at least the warning threshold", path: ["riskChangePct"] }),
    /** Metric keys the role waits for before it analyses (others are used when present). */
    requiredMetricKeys: z.array(z.string().trim().min(1).max(60)).max(40),
    /** Founders who get the "report ready" message. */
    recipients: z.array(z.uuid()).min(1, "Choose at least one founder to receive reports").max(10),
    /** Founders the role asks for missing numbers (founders only — never people records). */
    askUserIds: z.array(z.uuid()).min(1, "Choose at least one founder the role asks").max(10),
    /**
     * Accept a MONTH TOTAL entered for a daily number when its days are incomplete (complete
     * days still win). Off: a daily number counts only with every day in. Default: on for the
     * Financial Analyst (the founders' decision), off for other roles
     * (`defaultAcceptMonthlyTotals`).
     */
    acceptMonthlyTotals: z.boolean().optional(),
    /** Org Structure Expert: one person heading more than this many departments is flagged (default 4). */
    maxDepartmentsPerHead: z.coerce.number().int().min(1).max(21).optional(),
    /**
     * This hire's own rule checks (on/off + thresholds), overriding the role's. Absent = the
     * role's checks. The change thresholds stay in `thresholds` (the "vs the month before"
     * check) and the Org Expert's head limit in `maxDepartmentsPerHead`, as before.
     */
    checks: checksSchema.optional(),
    /** This hire's own name / job description / responsibilities / instructions (absent = the role's). */
    profile: profileSchema.optional(),
  })
  .strict();
export type HireSettings = z.infer<typeof hireSettingsSchema>;

export const hireCreateSchema = z
  .object({
    templateKey: z.string().trim().min(1).max(60),
    companyId: z.uuid(),
    settings: hireSettingsSchema.partial().optional(),
    notes: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(2000).nullable().optional()),
  })
  .strict();
export type HireCreateInput = z.input<typeof hireCreateSchema>;

export const hirePatchSchema = z
  .object({
    status: z.enum(["active", "paused"]).optional(),
    // `checks: null` / `profile: null` clear the hire's own override (back to the role's).
    settings: hireSettingsSchema.partial().extend({ checks: checksSchema.nullable().optional(), profile: profileSchema.nullable().optional() }).optional(),
    notes: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(2000).nullable().optional()),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });
export type HirePatchInput = z.input<typeof hirePatchSchema>;

export function defaultSettings(t: RoleTemplate, type: CompanyType, founderIds: readonly string[]): HireSettings {
  return {
    schedule: { ...t.defaultSchedule },
    thresholds: { ...DEFAULT_THRESHOLDS },
    requiredMetricKeys: requiredKeysFor(t, type),
    recipients: [...founderIds],
    askUserIds: [...founderIds],
    acceptMonthlyTotals: defaultAcceptMonthlyTotals(t.key),
  };
}

/** New hires: the Financial Analyst accepts month totals (founders' decision); other roles don't. */
export function defaultAcceptMonthlyTotals(templateKey: string): boolean {
  return templateKey === FINANCIAL_ANALYST;
}

// ---------------------------------------------------------------------------
// Months and schedule
// ---------------------------------------------------------------------------

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthStart(day: IsoDate): IsoDate {
  return `${day.slice(0, 7)}-01`;
}

export function prevMonth(start: IsoDate, n = 1): IsoDate {
  return addMonths(start, -n);
}

export function addMonths(start: IsoDate, n: number): IsoDate {
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7)) + n;
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** "October 2026". */
export function monthLabel(start: IsoDate): string {
  return `${MONTH_NAMES[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;
}

/** "October" (no year). */
export function monthName(start: IsoDate): string {
  return MONTH_NAMES[Number(start.slice(5, 7)) - 1]!;
}

/**
 * Months for a request line, short however long the list gets:
 * "October 2026", "September and October 2026", "June, August and October 2026";
 * consecutive months as a range: "August–October 2026", "November 2025–January 2026";
 * otherwise at most 3 named (the newest) then "(+N earlier)".
 */
export function monthsLabel(starts: readonly IsoDate[]): string {
  const sorted = [...new Set(starts)].sort();
  if (sorted.length === 0) return "";
  if (sorted.length === 1) return monthLabel(sorted[0]!);
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  const consecutive = sorted.every((m, i) => i === 0 || addMonths(sorted[i - 1]!, 1) === m);
  if (consecutive && sorted.length >= 3) {
    return first.slice(0, 4) === last.slice(0, 4) ? `${monthName(first)}–${monthLabel(last)}` : `${monthLabel(first)}–${monthLabel(last)}`;
  }
  const named = sorted.slice(-3);
  const earlier = sorted.length - named.length;
  const sameYear = named.every((s) => s.slice(0, 4) === named[0]!.slice(0, 4));
  const names = named.map((s) => (sameYear ? monthName(s) : monthLabel(s)));
  const text = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${sameYear ? `${text} ${named[0]!.slice(0, 4)}` : text}${earlier ? ` (+${earlier} earlier)` : ""}`;
}

/** Never (a role whose schedule is off). */
export const NEVER: IsoDate = "9999-12-31";

/** The first `weekday` (ISO, 1 = Monday) of the month starting `month`. */
export function firstWeekdayOfMonth(month: IsoDate, weekday: number): IsoDate {
  const first = monthStart(month);
  return addDays(first, (weekday - isoWeekday(first) + 7) % 7);
}

/** Day of the month a month's run is due: monthly → `day`; weekly → the first such weekday. */
function dueDayIn(month: IsoDate, schedule: Schedule): IsoDate {
  if (schedule.kind === "monthly") return addDays(monthStart(month), schedule.day - 1);
  if (schedule.kind === "weekly") return firstWeekdayOfMonth(month, schedule.weekday);
  return NEVER;
}

/**
 * The day a month's run is due: `schedule.day` of the following month (weekly: the first
 * such weekday of the following month; off: never).
 */
export function runDueOn(period: IsoDate, schedule: Schedule): IsoDate {
  return dueDayIn(addMonths(period, 1), schedule);
}

/**
 * The finished month whose run is due at `today`: last month once today is on or after the
 * schedule day, otherwise the month before that. Null when the schedule is off.
 */
export function scheduledPeriod(today: IsoDate, schedule: Schedule): IsoDate | null {
  if (schedule.kind === "off") return null;
  const last = prevMonth(monthStart(today));
  return today >= dueDayIn(today, schedule) ? last : prevMonth(last);
}

/** A summary-line role (Org Structure Expert): is today one of its days? */
export function summaryLineDueOn(today: IsoDate, schedule: Schedule): boolean {
  if (schedule.kind === "weekly") return isoWeekday(today) === schedule.weekday;
  if (schedule.kind === "monthly") return Number(today.slice(8, 10)) === schedule.day;
  return false;
}

/** The first month a hire analyses: the month that had just finished when it was hired. */
export function firstPeriodFor(hiredOn: IsoDate): IsoDate {
  return prevMonth(monthStart(hiredOn));
}

/** "Weekly on Mondays" for the org checks, otherwise "Monthly on the 10th". */
export function templateScheduleLabel(t: Pick<RoleTemplate, "engine" | "defaultSchedule">, s: Schedule = t.defaultSchedule): string {
  if (s.kind === "off") return runBased(templateEngine(t)) ? "Off (Run now only)" : "Off";
  // Org roles store their weekday; legacy monthly-day-1 rows (before 0021) meant Mondays.
  if (templateEngine(t) === "org_rules" && s.kind === "monthly" && s.day === 1 && t.defaultSchedule.kind === "weekly") return "Weekly on Mondays";
  return scheduleLabel(s, templateEngine(t));
}

/** "Monthly on the 10th", "Weekly on Mondays" (run roles: "Monthly on the first Monday"). */
export function scheduleLabel(s: Schedule, engine: RoleEngine = "finance"): string {
  if (s.kind === "off") return runBased(engine) ? "Off (Run now only)" : "Off";
  if (s.kind === "weekly") {
    const name = WEEKDAY_NAMES[s.weekday - 1]!;
    return engine === "org_rules" ? `Weekly on ${name}s` : `Monthly on the first ${name}`;
  }
  const d = s.day;
  const suffix = d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th";
  return `Monthly on the ${d}${suffix}`;
}

// ---------------------------------------------------------------------------
// Chasing cadence (anti-spam)
// ---------------------------------------------------------------------------

/** Days a data request is chased daily before it backs off to weekly. */
export const DAILY_CHASE_DAYS = 7;

/**
 * Whether a data request's line belongs in today's morning summary:
 * - never more than once per local day (`lastShownOn` < today);
 * - every day for the first 7 days after the request was created;
 * - after that only once a week (7+ days since it was last shown).
 */
export function chaseDueToday(createdOn: IsoDate, lastShownOn: IsoDate | null, today: IsoDate): boolean {
  if (today < createdOn) return false;
  if (lastShownOn && lastShownOn >= today) return false;
  if (daysBetween(createdOn, today) < DAILY_CHASE_DAYS) return true;
  return !lastShownOn || daysBetween(lastShownOn, today) >= DAILY_CHASE_DAYS;
}
