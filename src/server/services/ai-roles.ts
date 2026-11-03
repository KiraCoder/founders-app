import "server-only";
import { resolveAppBaseUrl } from "@/server/app-url";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import {
  addMonths,
  chaseDueToday,
  companyTypeFor,
  firstPeriodFor,
  hireCreateSchema,
  hirePatchSchema,
  hireSettingsSchema,
  monthLabel,
  prevMonth,
  monthStart,
  runBased,
  runDueOn,
  scheduledPeriod,
  templateScheduleLabel,
  ROLE_TEMPLATES,
  type CompanyType,
  type HireCreateInput,
  type HirePatchInput,
  type HireSettings,
  type RoleTemplate,
} from "@/lib/ai-roles";
import { ChecksError, cleanProfile, normalizeChecks, type ChecksConfig, type RoleEngine } from "@/lib/ai-role-config";
import { addDays, todayInTimeZone, type IsoDate } from "@/lib/dates";
import {
  analyseFinance,
  analysisChecksFrom,
  countBySeverity,
  defaultAnalysisChecks,
  historyMonthsFor,
  severitySummary,
  type AnalysisChecks,
  type Finding,
  type MonthSeries,
  type Severity,
} from "@/server/ai/finance-rules";
import { monthlyName, monthTotalKind, monthTotalMark, monthValue, periodsInMonth, type Granularity } from "@/server/ai/month-values";
import { generateNarrative, salaryLikeFinding } from "@/server/ai/narrative";
import { getLlmProvider, type LlmProvider } from "@/server/ai/provider";
import type { Db } from "@/server/db/connect";
import { syncAiTemplates } from "@/server/db/seed";
import {
  aiDataRequests,
  aiRoleHires,
  aiRoleRuns,
  companies,
  companyUnits,
  metricDefinitions,
  metricValues,
  users,
  type AiHireSettingsJson,
  type AiRoleHire,
  type AiRoleRun,
  type AiRunInputs,
  type AiRunMissing,
  type AiRunStatus,
} from "@/server/db/schema";
import { defaultRegistry, type ConnectorRegistry } from "@/server/connectors/registry";
import { listFounders } from "@/server/notifications/founders";
import { enqueue } from "@/server/notifications/outbox";
import type { NeutralMessage } from "@/server/notifications/types";
import { assertAiRolesAccess, assertCompanyAccess, assertValidId } from "./access";
import { hireChecks, isSalaryMetric, loadConfigRows, logSettingsChange, resolveAllRoles, resolveFrom, resolveRole, roleDefaultSettings, type ResolvedRole } from "./ai-role-defs";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { DEBT_METRIC_KEY } from "./holding";
import { recordMonthTotal } from "./metrics";
import { createTask } from "./tasks";

/**
 * AI roles: hire an AI agent for a role in a company, tune it once, then it runs.
 *
 * The AI Financial Analyst, per hire and per finished month:
 *   waiting_for_data → ready → analysed → reported   (failed on an unexpected error)
 * - On its schedule day (default the 10th) the tick creates the run for last month and checks
 *   the required numbers (the hire's tuned metric keys). Missing → `waiting_for_data` plus a
 *   DATA REQUEST per founder it asks (one grouped line in the morning summary, chased daily for
 *   7 days, then weekly; a new month supersedes the older request). Every tick re-checks.
 * - Complete → `ready` → the deterministic finance rules (src/server/ai/finance-rules.ts) →
 *   `analysed` (the AI narrative is attempted only when a provider is configured; with
 *   AI_PROVIDER=none it is recorded as `narrative_skipped`) → ONE "report ready" push per
 *   recipient founder (outbox dedupe `ai_report:<run>`, so never twice; it follows quiet hours,
 *   the daily budget/parking and "not linked" like every other push) → `reported`.
 * - "Run now" (a founder) does the same for last month at any time; a re-run with unchanged
 *   numbers changes nothing, with corrected numbers it re-analyses without a second push.
 *
 * Founders only (assertAiRolesAccess). Only founders are ever asked or notified.
 */

export const REPORT_KIND = "ai_report_ready";
export const reportDedupeKey = (runId: string) => `ai_report:${runId}`;
/** A "report ready" push not delivered within a week is dropped (the report stays on the page). */
const REPORT_PUSH_VALID_MS = 7 * 86_400_000;
const HISTORY_MONTHS = 3;
/** A run that keeps failing is tried at most this many times by the scheduler. */
export const MAX_RUN_ATTEMPTS = 5;
/** Wait before the scheduler tries a failed run again: after the 1st, 2nd, 3rd+ failure. */
export const RUN_RETRY_HOURS = [1, 6, 24] as const;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface RunSummary {
  id: string;
  period: IsoDate;
  periodLabel: string;
  status: AiRunStatus;
  counts: Record<Severity, number>;
  summary: string;
  reportedAt: string | null;
  /** Failed attempts in a row (0 after a success). */
  attempts: number;
  /** The scheduler stopped retrying (MAX_RUN_ATTEMPTS failures): only "Retry" runs it now. */
  gaveUp: boolean;
  /** When the scheduler tries it next (failed / re-analysis failed), ISO. */
  nextAttemptAt: string | null;
}

export interface HireView {
  id: string;
  templateKey: string;
  /** The hire's name (its own override, else the role's). */
  roleName: string;
  /** The role's name (without the hire's override). */
  roleBaseName: string;
  engine: RoleEngine;
  /** A founder-made role (ai_role_configs.kind = custom). */
  custom: boolean;
  /** Effective job description / responsibilities / instructions (hire override, else the role's). */
  description: string;
  responsibilities: string[];
  instructions: string | null;
  /** Effective rule checks (on/off + thresholds). */
  checks: ChecksConfig;
  companyId: string;
  companySlug: string;
  companyName: string;
  companyColor: string;
  companyType: CompanyType;
  status: "active" | "paused";
  settings: HireSettings;
  scheduleLabel: string;
  notes: string | null;
  hiredOn: IsoDate;
  hiredByName: string | null;
  recipientNames: string[];
  askNames: string[];
  latestRun: RunSummary | null;
}

export interface RunView extends RunSummary {
  hire: Pick<HireView, "id" | "roleName" | "companyId" | "companySlug" | "companyName" | "companyColor" | "status" | "settings">;
  missing: AiRunMissing[];
  findings: Finding[];
  inputs: AiRunInputs | null;
  narrative: string | null;
  narrativeStatus: string | null;
  /** Findings about pay data that are never sent to the AI provider (left out of its summary). */
  narrativeOmitted: number;
  provider: string | null;
  error: string | null;
  trigger: string;
  analysedAt: string | null;
  /** Deep link to enter the missing numbers. */
  numbersHref: string;
  /** Missing numbers computed by the Holding from акты (not entered by hand). */
  missingFromHolding: string[];
  /** A report was made, but its numbers were corrected since ("Run again" re-analyses). */
  inputsChanged: boolean;
  /** A report was made, but the role was tuned since (required numbers / thresholds). */
  settingsChanged: boolean;
  /**
   * Missing daily numbers a month value can be entered for on the report (the role accepts
   * monthly totals): metricId → "total" | "average" | "end-of-month value".
   */
  monthTotalEntry: Record<string, string>;
}

function findingsOf(run: Pick<AiRoleRun, "findings">): Finding[] {
  return (run.findings ?? []) as Finding[];
}

function runSummary(run: AiRoleRun): RunSummary {
  const f = findingsOf(run);
  return {
    id: run.id,
    period: run.period,
    periodLabel: monthLabel(run.period),
    status: run.status,
    counts: countBySeverity(f),
    summary:
      run.status === "waiting_for_data"
        ? `Waiting for ${run.missing.length} number${run.missing.length === 1 ? "" : "s"}`
        : run.status === "failed"
          ? run.attempts >= MAX_RUN_ATTEMPTS
            ? `Failed ${run.attempts} times — stopped retrying; Retry on the report`
            : "Failed — retried automatically"
          : severitySummary(f),
    reportedAt: run.reportedAt?.toISOString() ?? null,
    attempts: run.attempts,
    gaveUp: run.attempts >= MAX_RUN_ATTEMPTS,
    nextAttemptAt: run.attempts < MAX_RUN_ATTEMPTS ? (run.nextAttemptAt?.toISOString() ?? null) : null,
  };
}

/** Settings as stored, completed with defaults (older rows, partial input). */
function settingsOf(hire: Pick<AiRoleHire, "settings">, template: ResolvedRole, type: CompanyType, founderIds: string[]): HireSettings {
  const d = roleDefaultSettings(template, type, founderIds);
  const s = (hire.settings ?? {}) as Partial<AiHireSettingsJson>;
  // Stored as chosen: 0021 already rewrote the old "monthly 1" rows that meant Mondays, so a
  // "monthly on day 1" saved since then is honoured (no coercion to weekly).
  const schedule = s.schedule ?? d.schedule;
  return {
    schedule,
    thresholds: s.thresholds ?? d.thresholds,
    requiredMetricKeys: s.requiredMetricKeys ?? d.requiredMetricKeys,
    recipients: s.recipients ?? d.recipients,
    askUserIds: s.askUserIds ?? d.askUserIds,
    acceptMonthlyTotals: s.acceptMonthlyTotals ?? false,
    ...(s.maxDepartmentsPerHead ? { maxDepartmentsPerHead: s.maxDepartmentsPerHead } : {}),
    ...(s.checks ? { checks: s.checks } : {}),
    ...(s.profile && cleanProfile(s.profile) ? { profile: cleanProfile(s.profile) } : {}),
  };
}

/** The hire's identity: its own overrides, else the role's. */
function identityOf(role: ResolvedRole, settings: HireSettings) {
  const p = settings.profile ?? {};
  return {
    roleName: p.name || role.name,
    description: p.description || role.description,
    responsibilities: p.responsibilities?.length ? p.responsibilities : role.responsibilities,
    instructions: p.instructions || role.instructions || null,
  };
}

interface HireRow {
  hire: AiRoleHire;
  companySlug: string;
  companyName: string;
  companyColor: string;
  hiredByName: string | null;
}

async function loadHireRows(db: Db, where?: ReturnType<typeof eq>): Promise<HireRow[]> {
  const rows = await db
    .select({ hire: aiRoleHires, companySlug: companies.slug, companyName: companies.name, companyColor: companies.color, companySort: companies.sort, hiredByName: users.shortName })
    .from(aiRoleHires)
    .innerJoin(companies, eq(companies.id, aiRoleHires.companyId))
    .leftJoin(users, eq(users.id, aiRoleHires.hiredBy))
    .where(and(isNull(companies.archivedAt), where))
    .orderBy(asc(companies.sort), asc(aiRoleHires.createdAt));
  return rows.map((r) => ({ hire: r.hire, companySlug: r.companySlug, companyName: r.companyName, companyColor: r.companyColor, hiredByName: r.hiredByName ?? null }));
}

async function toHireViews(db: Db, rows: HireRow[]): Promise<HireView[]> {
  if (!rows.length) return [];
  const founders = await listFounders(db);
  const founderIds = founders.map((f) => f.id);
  const nameOf = (id: string) => founders.find((f) => f.id === id)?.shortName ?? "?";
  const runs = await db
    .select()
    .from(aiRoleRuns)
    .where(inArray(aiRoleRuns.hireId, rows.map((r) => r.hire.id)))
    .orderBy(desc(aiRoleRuns.period));
  const configs = await loadConfigRows(db);
  return rows.flatMap(({ hire, companySlug, companyName, companyColor, hiredByName }) => {
    const template = resolveFrom(hire.templateKey, configs.get(hire.templateKey));
    if (!template) return [];
    const type = companyTypeFor(companySlug);
    const settings = settingsOf(hire, template, type, founderIds);
    const latest = runs.find((r) => r.hireId === hire.id);
    const identity = identityOf(template, settings);
    return {
      id: hire.id,
      templateKey: hire.templateKey,
      roleName: identity.roleName,
      roleBaseName: template.name,
      engine: template.engine,
      custom: template.custom,
      description: identity.description,
      responsibilities: identity.responsibilities,
      instructions: identity.instructions,
      checks: hireChecks(template, settings),
      companyId: hire.companyId,
      companySlug,
      companyName,
      companyColor,
      companyType: type,
      status: hire.status,
      settings,
      scheduleLabel: templateScheduleLabel(template, settings.schedule),
      notes: hire.notes,
      hiredOn: hire.hiredOn,
      hiredByName,
      recipientNames: settings.recipients.map(nameOf),
      askNames: settings.askUserIds.map(nameOf),
      latestRun: latest ? runSummary(latest) : null,
    };
  });
}

export function listTemplates(): RoleTemplate[] {
  return [...ROLE_TEMPLATES].sort((a, b) => a.sort - b.sort);
}

/** Every role the founders can hire or edit: built-ins (with their edits) and custom roles. */
export async function listRoles(ctx: ServiceContext): Promise<ResolvedRole[]> {
  assertAiRolesAccess(ctx);
  return resolveAllRoles(ctx.db);
}

export async function listHires(ctx: ServiceContext, opts: { companyId?: string } = {}): Promise<HireView[]> {
  assertAiRolesAccess(ctx);
  if (opts.companyId) await assertCompanyAccess(ctx, opts.companyId);
  return toHireViews(ctx.db, await loadHireRows(ctx.db, opts.companyId ? eq(aiRoleHires.companyId, opts.companyId) : undefined));
}

export async function getHire(ctx: ServiceContext, id: unknown): Promise<HireView> {
  assertAiRolesAccess(ctx);
  assertValidId(id, "AI role");
  const [view] = await toHireViews(ctx.db, await loadHireRows(ctx.db, eq(aiRoleHires.id, id)));
  if (!view) throw new ServiceError("not_found", "AI role not found");
  return view;
}

export async function listHireRuns(ctx: ServiceContext, hireId: string, limit = 12): Promise<RunSummary[]> {
  await getHire(ctx, hireId);
  const rows = await ctx.db.select().from(aiRoleRuns).where(eq(aiRoleRuns.hireId, hireId)).orderBy(desc(aiRoleRuns.period)).limit(limit);
  return rows.map(runSummary);
}

// ---------------------------------------------------------------------------
// Company numbers (read as the system: company data is shared between the founders)
// ---------------------------------------------------------------------------

export interface CompanyMetricOption {
  id: string;
  key: string;
  label: string;
  unit: string;
  granularity: Granularity;
}

interface MetricDef extends CompanyMetricOption {
  name: string;
  aliases: string[];
  /** Flagged as pay data (metric_definitions.is_pay_data). */
  isPayData: boolean;
  /** Factory / unit name ("ХБК"), null for the whole company. */
  unitName: string | null;
  unitSlug: string | null;
  aggregation: "sum" | "avg" | "last";
  direction: "higher_is_better" | "lower_is_better" | "neutral";
  target: string | null;
  sourceKind: "manual" | "upload" | "connector" | "derived" | "extension";
  connectorId: string | null;
}

/**
 * A number the Holding computes from акты and payments (intercompany debt, or any `derived`
 * number). A role never asks the founders to enter it: the Holding section owns asking for
 * the акты, and a hand-entered value would block later derived updates.
 */
export function holdingFed(d: { key: string; sourceKind?: string }): boolean {
  return d.key === DEBT_METRIC_KEY || d.sourceKind === "derived";
}

/** A connector-only number whose data source is not connected: the source's short reason. */
function awaitingSourceOf(def: Pick<MetricDef, "sourceKind" | "connectorId">, registry: ConnectorRegistry): string | null {
  if (def.sourceKind !== "connector") return null;
  const setup = def.connectorId ? registry.get(def.connectorId)?.setup() : undefined;
  return setup?.configured ? null : (setup?.shortReason ?? "a data source");
}

async function companyMetricDefs(db: Db, companyId: string): Promise<MetricDef[]> {
  const rows = await db
    .select({ d: metricDefinitions, unitName: companyUnits.name, unitSlug: companyUnits.slug })
    .from(metricDefinitions)
    .leftJoin(companyUnits, eq(companyUnits.id, metricDefinitions.companyUnitId))
    .where(and(eq(metricDefinitions.companyId, companyId), isNull(metricDefinitions.archivedAt)))
    .orderBy(asc(metricDefinitions.sort), asc(metricDefinitions.name));
  return rows.map(({ d, unitName, unitSlug }) => ({
    id: d.id,
    key: d.key,
    name: d.name,
    aliases: d.aliases ?? [],
    isPayData: d.isPayData,
    label: unitName ? `${d.name} · ${unitName}` : d.name,
    unitName: unitName ?? null,
    unit: d.unit,
    unitSlug: unitSlug ?? null,
    granularity: d.granularity,
    aggregation: d.aggregation,
    direction: d.direction,
    target: d.target,
    sourceKind: d.sourceKind,
    connectorId: d.connectorId ?? null,
  }));
}

/**
 * The metrics a role can wait for in this company (for the Tune wizard and the role editor),
 * one entry per key. `payData`: a custom role may never watch it (salary guard).
 */
export async function companyMetricOptions(
  ctx: ServiceContext,
  companyId: string,
): Promise<{ key: string; label: string; granularity: Granularity; unit: string; payData: boolean }[]> {
  assertAiRolesAccess(ctx);
  assertValidId(companyId, "Company");
  await assertCompanyAccess(ctx, companyId);
  const defs = await companyMetricDefs(ctx.db, companyId);
  const byKey = new Map<string, { key: string; label: string; granularity: Granularity; unit: string; payData: boolean }>();
  for (const d of defs) {
    const prev = byKey.get(d.key);
    if (!prev) byKey.set(d.key, { key: d.key, label: d.name, granularity: d.granularity, unit: d.unit, payData: isSalaryMetric(d) });
    else if (isSalaryMetric(d)) prev.payData = true;
  }
  return [...byKey.values()];
}

/** Keys of the metrics flagged as pay data (never in an AI prompt). */
function payKeysOf(defs: readonly Pick<MetricDef, "key" | "isPayData">[]): ReadonlySet<string> {
  return new Set(defs.filter((d) => d.isPayData).map((d) => d.key));
}

/**
 * The numbers a hire analyses: every number of the company, or — for a custom role — only
 * the ones it watches, never pay data (the salary guard, also re-checked here at run time).
 */
function analysedDefs(defs: MetricDef[], role: Pick<ResolvedRole, "custom" | "watchedMetricKeys">): MetricDef[] {
  if (!role.custom) return defs;
  const watched = new Set(role.watchedMetricKeys);
  return defs.filter((d) => watched.has(d.key) && !isSalaryMetric(d));
}

interface CompanyNumbers {
  defs: MetricDef[];
  /** metricId → period start → decimal text (current values only). */
  values: Map<string, Map<IsoDate, string>>;
  /** metricId → month → month total entered for a daily number (current values only). */
  monthTotals: Map<string, Map<IsoDate, string>>;
  /** metricIds that have a period value (day / week / month) before the window. */
  hadEarlier: Set<string>;
  /**
   * metricIds that have a month total (daily numbers) before the window. Counts as earlier
   * data only for a hire with acceptMonthlyTotals (the same rule as for the values it uses).
   */
  hadEarlierTotal: Set<string>;
}

async function loadCompanyNumbers(
  db: Db,
  companyId: string,
  months: IsoDate[],
  role?: Pick<ResolvedRole, "custom" | "watchedMetricKeys">,
): Promise<CompanyNumbers> {
  const all = await companyMetricDefs(db, companyId);
  const defs = role ? analysedDefs(all, role) : all;
  const values = new Map<string, Map<IsoDate, string>>();
  const monthTotals = new Map<string, Map<IsoDate, string>>();
  const hadEarlier = new Set<string>();
  const hadEarlierTotal = new Set<string>();
  if (!defs.length) return { defs, values, monthTotals, hadEarlier, hadEarlierTotal };
  const from = months[0]!;
  const to = addDays(addMonths(months.at(-1)!, 1), -1);
  const rows = await db
    .select({ metricId: metricValues.metricId, period: metricValues.periodStart, value: metricValues.value, kind: metricValues.periodKind })
    .from(metricValues)
    .where(
      and(
        inArray(metricValues.metricId, defs.map((d) => d.id)),
        eq(metricValues.isCurrent, true),
        sql`${metricValues.periodStart} between ${from} and ${to}`,
      ),
    );
  for (const r of rows) {
    // Month totals of daily numbers are kept apart: never mixed into the days.
    const target = r.kind === "month_total" ? monthTotals : values;
    const m = target.get(r.metricId) ?? new Map<IsoDate, string>();
    m.set(r.period, r.value);
    target.set(r.metricId, m);
  }
  const earlier = await db
    .selectDistinct({ metricId: metricValues.metricId, kind: metricValues.periodKind })
    .from(metricValues)
    .where(and(inArray(metricValues.metricId, defs.map((d) => d.id)), eq(metricValues.isCurrent, true), lt(metricValues.periodStart, from)));
  // Kept apart like the values: a month total alone must not flip "never entered" (info) to
  // "2+ months missing" (warn) for a hire that ignores month totals.
  for (const e of earlier) (e.kind === "month_total" ? hadEarlierTotal : hadEarlier).add(e.metricId);
  return { defs, values, monthTotals, hadEarlier, hadEarlierTotal };
}

/** Plain "12345.6700" → "12345.67" (Postgres numeric text keeps 4 decimals). */
function cleanDecimal(v: string): string {
  return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
}

interface Evaluation {
  missing: AiRunMissing[];
  inputs: AiRunInputs;
  series: MonthSeries[];
}

/**
 * One value per metric and month. With `acceptMonthlyTotals` a daily number whose days are
 * incomplete takes the month total a founder entered (complete days always win).
 */
function evaluateNumbers(numbers: CompanyNumbers, period: IsoDate, required: readonly string[], acceptMonthlyTotals = false, history = HISTORY_MONTHS): Evaluation {
  const months = monthsFor(period, history);
  const missing: AiRunMissing[] = [];
  const series: MonthSeries[] = [];
  const inputs: AiRunInputs = { months, metrics: [] };
  for (const d of numbers.defs) {
    const vals = numbers.values.get(d.id) ?? new Map<IsoDate, string>();
    const totals = acceptMonthlyTotals && d.granularity === "day" ? (numbers.monthTotals.get(d.id) ?? new Map<IsoDate, string>()) : undefined;
    const monthVals: Record<IsoDate, string | null> = {};
    const fromTotal: boolean[] = [];
    for (const m of months) {
      const mv = monthValue(d, vals, m, totals?.get(m) ?? null);
      monthVals[m] = "value" in mv ? cleanDecimal(mv.value) : null;
      fromTotal.push("value" in mv && !!mv.fromMonthTotal);
      if (m === period && required.includes(d.key) && !("value" in mv)) {
        let detail =
          d.granularity === "month"
            ? "no value"
            : mv.missing === mv.total
              ? `no values (${mv.total} ${d.granularity === "day" ? "days" : "weeks"})`
              : `${mv.missing} of ${mv.total} ${d.granularity === "day" ? "days" : "weeks"} missing`;
        if (totals) detail += ` — or enter the month ${monthTotalKind(d.aggregation)}`;
        missing.push({ metricId: d.id, key: d.key, label: d.label, detail });
      }
    }
    // Reports show MONTH values: label them as such ("Orders (month total)", not "Orders per
    // day"). The missing list above keeps the entry name (what the founders fill in).
    const mName = monthlyName(d);
    const mLabel = d.unitName ? `${mName} · ${d.unitName}` : mName;
    series.push({
      metricId: d.id,
      key: d.key,
      name: mName,
      label: mLabel,
      entryLabel: d.label,
      unitSlug: d.unitSlug,
      unit: d.unit,
      direction: d.direction,
      target: d.target === null ? null : cleanDecimal(d.target),
      months: monthVals,
      // Month totals count as data only when this hire uses them (acceptMonthlyTotals).
      everHadData:
        numbers.hadEarlier.has(d.id) || vals.size > 0 || (!!totals && (numbers.hadEarlierTotal.has(d.id) || totals.size > 0)),
    });
    inputs.metrics.push({
      metricId: d.id,
      key: d.key,
      label: mLabel,
      unit: d.unit,
      values: months.map((m) => monthVals[m] ?? null),
      // Only present when a month total was used, so reports made without one keep their hash.
      ...(fromTotal.some(Boolean) ? { fromMonthTotal: fromTotal, monthTotalMark: monthTotalMark(d.aggregation) } : {}),
    });
  }
  return { missing, inputs, series };
}

const sha256 = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The month analysed and the `history` months before it, oldest first. */
function monthsFor(period: IsoDate, history: number): IsoDate[] {
  return Array.from({ length: history + 1 }, (_, i) => prevMonth(period, history - i));
}

/**
 * What the analysis of a hire depends on besides the numbers: its checks (only when they
 * differ from the defaults, so reports made before the editor keep their hash) and, for a
 * custom role, the numbers it watches and its ratio checks.
 */
function analysisKey(hc: Pick<HireContext, "analysis" | "settings" | "template">): string | undefined {
  const differs = JSON.stringify(hc.analysis) !== JSON.stringify(defaultAnalysisChecks(hc.settings.thresholds));
  if (!differs && !hc.template.custom) return undefined;
  return JSON.stringify({ analysis: hc.analysis, ...(hc.template.custom ? { watched: [...hc.template.watchedMetricKeys].sort() } : {}) });
}

/** The numbers an analysis used (a correction changes it → "Numbers changed"). */
function hashInputs(inputs: AiRunInputs): string {
  return sha256({ inputs });
}

/**
 * The settings an analysis used (a Tune changes it → "Settings changed"). "Accept monthly
 * totals" is part of it only when on, so reports made before the switch existed keep their hash.
 */
function hashSettings(required: readonly string[], thresholds: HireSettings["thresholds"], acceptMonthlyTotals = false, checks?: string): string {
  return sha256({
    required: [...required].sort(),
    thresholds: { changePct: thresholds.changePct, riskChangePct: thresholds.riskChangePct },
    ...(acceptMonthlyTotals ? { acceptMonthlyTotals: true } : {}),
    ...(checks ? { checks } : {}),
  });
}

/** Rows analysed before 0013 stored one hash over numbers and settings together. */
function legacyHash(inputs: AiRunInputs, required: readonly string[], thresholds: HireSettings["thresholds"]): string {
  return sha256({ inputs, required: [...required].sort(), thresholds });
}

/** What changed since a report was made: its numbers, the role's settings, or neither. */
function reportDrift(run: Pick<AiRoleRun, "inputsHash" | "settingsHash">, inputs: AiRunInputs, settings: HireSettings, checks?: string): { inputs: boolean; settings: boolean } {
  if (!run.inputsHash) return { inputs: false, settings: false };
  if (run.settingsHash === null) {
    // Legacy row: one combined hash, so a difference can't be split — report it as numbers.
    return { inputs: legacyHash(inputs, settings.requiredMetricKeys, settings.thresholds) !== run.inputsHash, settings: false };
  }
  return {
    inputs: hashInputs(inputs) !== run.inputsHash,
    settings: hashSettings(settings.requiredMetricKeys, settings.thresholds, settings.acceptMonthlyTotals, checks) !== run.settingsHash,
  };
}

// ---------------------------------------------------------------------------
// The run engine (tick and "Run now")
// ---------------------------------------------------------------------------

export interface EngineOptions {
  timeZone?: string;
  /** Provider for the narrative (default: AI_PROVIDER, i.e. "none"). */
  provider?: LlmProvider;
  /** Test seam: replaces the finance rules (e.g. to simulate a crash). */
  analyse?: typeof analyseFinance;
}

interface HireContext {
  hire: AiRoleHire;
  template: ResolvedRole;
  settings: HireSettings;
  /** The hire's name (its own override, else the role's). */
  roleName: string;
  instructions: string | null;
  checks: ChecksConfig;
  /** The checks as the analysis runs them (finance / custom roles). */
  analysis: AnalysisChecks;
  companyName: string;
  companySlug: string;
}

async function hireContext(db: Db, hireId: string): Promise<HireContext | null> {
  const [row] = await loadHireRows(db, eq(aiRoleHires.id, hireId));
  if (!row) return null;
  const template = await resolveRole(db, row.hire.templateKey);
  if (!template) return null;
  const founderIds = (await listFounders(db)).map((f) => f.id);
  const settings = settingsOf(row.hire, template, companyTypeFor(row.companySlug), founderIds);
  const checks = hireChecks(template, settings);
  const identity = identityOf(template, settings);
  return {
    hire: row.hire,
    template,
    settings,
    roleName: identity.roleName,
    instructions: identity.instructions,
    checks,
    analysis: analysisChecksFrom(template.engine, checks, settings.thresholds, template.ratioChecks),
    companyName: row.companyName,
    companySlug: row.companySlug,
  };
}

async function ensureRun(db: Db, hireId: string, period: IsoDate, trigger: "schedule" | "manual", now: Date): Promise<AiRoleRun> {
  await db.insert(aiRoleRuns).values({ hireId, period, trigger, createdAt: now, updatedAt: now }).onConflictDoNothing({ target: [aiRoleRuns.hireId, aiRoleRuns.period] });
  const [run] = await db.select().from(aiRoleRuns).where(and(eq(aiRoleRuns.hireId, hireId), eq(aiRoleRuns.period, period)));
  return run!;
}

/**
 * Checks one run's data and moves it along the state machine. Idempotent: unchanged numbers
 * leave an analysed / reported run alone; the "report ready" push is queued once per run.
 */
export async function evaluateRun(db: Db, hc: HireContext, run: AiRoleRun, now: Date, opts: EngineOptions = {}): Promise<AiRoleRun> {
  const update = async (set: Partial<typeof aiRoleRuns.$inferInsert>) => {
    const [row] = await db.update(aiRoleRuns).set({ ...set, updatedAt: now }).where(eq(aiRoleRuns.id, run.id)).returning();
    return row!;
  };
  try {
    const required = hc.settings.requiredMetricKeys;
    const history = historyMonthsFor(hc.analysis);
    const months = monthsFor(run.period, history);
    const numbers = await loadCompanyNumbers(db, hc.hire.companyId, months, hc.template);
    const ev = evaluateNumbers(numbers, run.period, required, hc.settings.acceptMonthlyTotals, history);
    const checksHash = analysisKey(hc);
    if (ev.missing.length) {
      // A report already made stays (numbers were removed / settings changed later): only a
      // run that has not been analysed goes (back) to waiting.
      if (run.status === "analysed" || run.status === "reported") return run;
      return update({ status: "waiting_for_data", missing: ev.missing, error: null, attempts: 0, nextAttemptAt: null });
    }
    const drift = reportDrift(run, ev.inputs, hc.settings, checksHash);
    let current = run;
    if (!((run.status === "analysed" || run.status === "reported") && !drift.inputs && !drift.settings)) {
      if (run.status !== "analysed" && run.status !== "reported") current = await update({ status: "ready", missing: [], error: null });
      const findings = (opts.analyse ?? analyseFinance)({
        companyName: hc.companyName,
        period: run.period,
        series: ev.series,
        thresholds: hc.settings.thresholds,
        checks: hc.analysis,
      });
      const narrative = await generateNarrative(
        {
          roleName: hc.roleName,
          companyName: hc.companyName,
          periodLabel: monthLabel(run.period),
          instructions: hc.instructions,
          findings,
          payKeys: payKeysOf(numbers.defs),
        },
        opts.provider ?? getLlmProvider(),
      );
      // Written under the row lock that "Create task" also takes: the task links are read from
      // the locked row (not from the copy read before the analysis), so a task created while
      // this run was analysing is kept on its finding, and never created twice.
      current = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(aiRoleRuns).where(eq(aiRoleRuns.id, run.id)).for("update");
        const links = new Map(findingsOf(locked!).flatMap((f) => (f.taskId ? [[f.id, f.taskId] as const] : [])));
        for (const f of findings) if (!f.taskId && links.has(f.id)) f.taskId = links.get(f.id);
        const [row] = await tx
          .update(aiRoleRuns)
          .set({
            status: locked!.status === "reported" ? "reported" : "analysed",
            missing: [],
            inputs: ev.inputs,
            inputsHash: hashInputs(ev.inputs),
            settingsHash: hashSettings(required, hc.settings.thresholds, hc.settings.acceptMonthlyTotals, checksHash),
            findings,
            narrative: narrative.text,
            narrativeStatus: narrative.status,
            provider: narrative.provider,
            error: null,
            attempts: 0,
            nextAttemptAt: null,
            analysedAt: now,
            updatedAt: now,
          })
          .where(eq(aiRoleRuns.id, run.id))
          .returning();
        return row!;
      });
    }
    if (current.status === "analysed") {
      await queueReportPushes(db, hc, current, now);
      current = await update({ status: "reported", reportedAt: current.reportedAt ?? now, error: null, attempts: 0, nextAttemptAt: null });
    } else if (current.attempts || current.error) {
      current = await update({ error: null, attempts: 0, nextAttemptAt: null });
    }
    return current;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-roles] run ${run.id} failed: ${message}`);
    const [latest] = await db.select().from(aiRoleRuns).where(eq(aiRoleRuns.id, run.id));
    const attempts = (latest?.attempts ?? run.attempts) + 1;
    const hours = RUN_RETRY_HOURS[Math.min(attempts, RUN_RETRY_HOURS.length) - 1]!;
    return update({
      // A report already made is kept (last good report); only a run without one is "failed".
      status: latest?.status === "analysed" || latest?.status === "reported" ? latest.status : "failed",
      error: message.slice(0, 500),
      attempts,
      nextAttemptAt: attempts >= MAX_RUN_ATTEMPTS ? null : new Date(now.getTime() + hours * 3_600_000),
    });
  }
}

/** ONE "report ready" push per recipient founder per run (dedupe key), sent by the dispatcher. */
async function queueReportPushes(db: Db, hc: HireContext, run: AiRoleRun, now: Date): Promise<void> {
  const founders = new Set((await listFounders(db)).map((f) => f.id));
  for (const userId of hc.settings.recipients) {
    if (!founders.has(userId)) continue; // only founders are ever notified
    await enqueue(db, {
      userId,
      kind: REPORT_KIND,
      dedupeKey: reportDedupeKey(run.id),
      scheduledFor: now,
      expiresAt: new Date(now.getTime() + REPORT_PUSH_VALID_MS),
      priority: "normal",
      payload: { runId: run.id },
    });
  }
}

export interface AiPlanReport {
  runsCreated: number;
  evaluated: number;
  requestsCreated: number;
}

/**
 * Tick hook (see orchestrator.ts): for every active hire, create the run that is due by the
 * schedule, re-check every run that is not done yet, and keep the data requests in step.
 */
export async function planAiRoles(db: Db, now: Date, opts: EngineOptions = {}): Promise<AiPlanReport> {
  const tz = opts.timeZone ?? (process.env.APP_TIMEZONE || "Asia/Bishkek");
  const todayIso = todayInTimeZone(now, tz);
  const report: AiPlanReport = { runsCreated: 0, evaluated: 0, requestsCreated: 0 };
  const hires = await db.select({ id: aiRoleHires.id }).from(aiRoleHires).where(eq(aiRoleHires.status, "active"));
  for (const { id } of hires) {
    try {
      const hc = await hireContext(db, id);
      if (!hc || hc.template.status !== "available") continue;
      // The Org Structure Expert has no monthly runs: its checks are live (org board) and its
      // Monday line is composed with the morning summary (orchestrator).
      if (!runBased(hc.template.engine)) continue;
      const period = scheduledPeriod(todayIso, hc.settings.schedule);
      if (period && period >= firstPeriodFor(hc.hire.hiredOn)) {
        const [exists] = await db.select({ id: aiRoleRuns.id }).from(aiRoleRuns).where(and(eq(aiRoleRuns.hireId, id), eq(aiRoleRuns.period, period)));
        if (!exists) {
          await ensureRun(db, id, period, "schedule", now);
          report.runsCreated++;
        }
      }
      // A run that failed waits for its backoff (1 h, 6 h, 24 h) and is left alone after
      // MAX_RUN_ATTEMPTS failures until a founder clicks Retry.
      const open = await db
        .select()
        .from(aiRoleRuns)
        .where(
          and(
            eq(aiRoleRuns.hireId, id),
            inArray(aiRoleRuns.status, ["waiting_for_data", "ready", "analysed", "failed"]),
            lt(aiRoleRuns.attempts, MAX_RUN_ATTEMPTS),
            or(isNull(aiRoleRuns.nextAttemptAt), lte(aiRoleRuns.nextAttemptAt, now)),
          ),
        )
        .orderBy(asc(aiRoleRuns.period));
      for (const run of open) {
        await evaluateRun(db, hc, run, now, opts);
        report.evaluated++;
      }
      report.requestsCreated += await syncDataRequests(db, hc, todayIso, now);
    } catch (err) {
      console.error(`[ai-roles] hire ${id} failed`, err);
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Data requests (chasing, anti-spam)
// ---------------------------------------------------------------------------

/**
 * Keeps a hire's data requests in step with its waiting runs: a request per founder it asks
 * for the newest month that is due and still waiting (older waiting months are included on
 * the same line); a new round supersedes that founder's older active request of the hire;
 * founders no longer asked and hires that need nothing get theirs closed.
 */
async function syncDataRequests(db: Db, hc: HireContext, todayIso: IsoDate, now: Date): Promise<number> {
  const waiting = await db
    .select()
    .from(aiRoleRuns)
    .where(and(eq(aiRoleRuns.hireId, hc.hire.id), eq(aiRoleRuns.status, "waiting_for_data")))
    .orderBy(asc(aiRoleRuns.period));
  const due = waiting.filter((r) => runDueOn(r.period, hc.settings.schedule) <= todayIso);
  const active = and(eq(aiDataRequests.hireId, hc.hire.id), eq(aiDataRequests.status, "active"));
  if (!due.length) {
    if (!waiting.length) {
      await db.update(aiDataRequests).set({ status: "done", reason: "data_complete", resolvedAt: now }).where(active);
    }
    return 0;
  }
  const founders = new Set((await listFounders(db)).map((f) => f.id));
  const askIds = hc.settings.askUserIds.filter((id) => founders.has(id));
  await db
    .update(aiDataRequests)
    .set({ status: "cancelled", reason: "not_asked", resolvedAt: now })
    .where(and(active, askIds.length ? notInArray(aiDataRequests.userId, askIds) : undefined));
  const roundKey = due.at(-1)!.period;
  let created = 0;
  for (const userId of askIds) {
    const rows = await db
      .insert(aiDataRequests)
      .values({ hireId: hc.hire.id, userId, roundKey, createdOn: todayIso, createdAt: now })
      // A request closed because the role was paused or the founder was no longer asked comes
      // back once the role runs / asks them again — with its ORIGINAL cadence (createdOn,
      // lastShownOn kept): pausing / toggling a founder never restarts 7 days of daily chasing.
      // Done or superseded ones don't come back.
      .onConflictDoUpdate({
        target: [aiDataRequests.hireId, aiDataRequests.userId, aiDataRequests.roundKey],
        set: { status: "active", reason: null, resolvedAt: null },
        setWhere: sql`${aiDataRequests.status} = 'cancelled' and ${aiDataRequests.reason} in ('paused', 'not_asked')`,
      })
      .returning({ id: aiDataRequests.id });
    if (!rows[0]) continue;
    created++;
    // Anti-spam: the new round already covers every month still waiting, so the older
    // request (maybe never delivered: not linked, quiet hours) is superseded, not stacked.
    await db
      .update(aiDataRequests)
      .set({ status: "cancelled", reason: "superseded", resolvedAt: now })
      .where(and(eq(aiDataRequests.hireId, hc.hire.id), eq(aiDataRequests.userId, userId), eq(aiDataRequests.status, "active"), ne(aiDataRequests.id, rows[0].id)));
  }
  return created;
}

export interface AiRequestItem {
  requestId: string;
  hireId: string;
  roleName: string;
  companyName: string;
  companySlug: string;
  /** Months still waiting (oldest first). */
  months: IsoDate[];
  /**
   * Missing numbers across those months the founders can enter (one entry per metric), with
   * the months each is missing for (the orchestrator hides only those periods from "Numbers
   * waiting").
   */
  missing: {
    metricId: string;
    key: string;
    label: string;
    granularity: Granularity;
    /** How the number becomes a month value (sum → a total, avg → an average). */
    aggregation?: "sum" | "avg" | "last";
    months?: IsoDate[];
    /**
     * Expected from a data source that is not connected yet (its short reason, "Edil's
     * APIs"): the founders can only enter it by hand or upload it until it is.
     */
    awaitingSource?: string | null;
  }[];
  /**
   * Missing numbers the Holding computes from акты (never asked by the role; the Holding
   * section asks for the акты). Still listed here so "Numbers waiting" doesn't ask for them.
   */
  waitingOnHolding: { metricId: string; key: string; label: string; months?: IsoDate[] }[];
  /** True when today is one of the request's chase days (daily for 7 days, then weekly). */
  dueToday: boolean;
  /** The role accepts a month total for daily numbers ("enter the October total (or every day)"). */
  acceptMonthlyTotals?: boolean;
}

/** An absolute link when the site's address is known (APP_URL, or Vercel's), else the path. */
export function appUrl(path: string): string {
  const base = resolveAppBaseUrl()?.url;
  return base ? `${base}${path}` : path;
}

export function numbersHref(companySlug: string, g: Granularity): string {
  return `/companies/${companySlug}?tab=numbers&g=${g}`;
}

/**
 * A founder's active data requests (at most one per hire), with what is still missing and
 * whether today is a chase day. Requests whose numbers all arrived are closed here. The
 * orchestrator turns these into morning-summary lines and dedupes them against the other
 * sections (src/server/ai/orchestrator.ts).
 */
export async function collectAiRequests(ctx: ServiceContext, opts: { registry?: ConnectorRegistry } = {}): Promise<AiRequestItem[]> {
  const registry = opts.registry ?? defaultRegistry();
  const requests = await ctx.db
    .select({ r: aiDataRequests })
    .from(aiDataRequests)
    .innerJoin(aiRoleHires, eq(aiRoleHires.id, aiDataRequests.hireId))
    .where(and(eq(aiDataRequests.userId, ctx.user.id), eq(aiDataRequests.status, "active"), eq(aiRoleHires.status, "active")))
    .orderBy(asc(aiDataRequests.createdAt));
  if (!requests.length) return [];
  const todayIso = today(ctx);
  // Backstop: at most one active request per hire (the newest); older ones are superseded.
  const newest = new Map<string, (typeof requests)[number]["r"]>();
  for (const { r } of requests) {
    const prev = newest.get(r.hireId);
    if (prev) {
      await ctx.db.update(aiDataRequests).set({ status: "cancelled", reason: "superseded", resolvedAt: ctx.now }).where(eq(aiDataRequests.id, prev.id));
    }
    newest.set(r.hireId, r);
  }
  const out: AiRequestItem[] = [];
  for (const r of newest.values()) {
    const hc = await hireContext(ctx.db, r.hireId);
    if (!hc) continue;
    const waiting = await ctx.db
      .select()
      .from(aiRoleRuns)
      .where(and(eq(aiRoleRuns.hireId, r.hireId), eq(aiRoleRuns.status, "waiting_for_data")))
      .orderBy(asc(aiRoleRuns.period));
    if (!waiting.length) {
      await ctx.db.update(aiDataRequests).set({ status: "done", reason: "data_complete", resolvedAt: ctx.now }).where(eq(aiDataRequests.id, r.id));
      continue;
    }
    const defs = new Map((await companyMetricDefs(ctx.db, hc.hire.companyId)).map((d) => [d.id, d]));
    const missing: AiRequestItem["missing"] = [];
    const waitingOnHolding: AiRequestItem["waitingOnHolding"] = [];
    for (const run of waiting) {
      for (const m of run.missing) {
        const seen = missing.find((x) => x.metricId === m.metricId) ?? waitingOnHolding.find((x) => x.metricId === m.metricId);
        if (seen) {
          seen.months!.push(run.period);
          continue;
        }
        const def = defs.get(m.metricId);
        if (holdingFed({ key: m.key, sourceKind: def?.sourceKind })) waitingOnHolding.push({ metricId: m.metricId, key: m.key, label: m.label, months: [run.period] });
        else
          missing.push({
            metricId: m.metricId,
            key: m.key,
            label: m.label,
            granularity: def?.granularity ?? "month",
            aggregation: def?.aggregation,
            months: [run.period],
            awaitingSource: def ? awaitingSourceOf(def, registry) : null,
          });
      }
    }
    out.push({
      requestId: r.id,
      hireId: r.hireId,
      roleName: hc.roleName,
      companyName: hc.companyName,
      companySlug: hc.companySlug,
      months: waiting.map((w) => w.period),
      missing,
      waitingOnHolding,
      dueToday: chaseDueToday(r.createdOn, r.lastShownOn, todayIso),
      acceptMonthlyTotals: hc.settings.acceptMonthlyTotals === true,
    });
  }
  return out;
}

/** After the morning summary was delivered: those requests were chased today (at most once a day). */
export async function markRequestsShown(db: Db, ids: readonly string[], todayIso: IsoDate, outboxId: string): Promise<void> {
  if (!ids.length) return;
  await db
    .update(aiDataRequests)
    .set({ lastShownOn: todayIso, shownCount: sql`${aiDataRequests.shownCount} + 1`, outboxId })
    .where(
      and(
        inArray(aiDataRequests.id, [...ids]),
        eq(aiDataRequests.status, "active"),
        or(isNull(aiDataRequests.lastShownOn), lt(aiDataRequests.lastShownOn, todayIso)),
      ),
    );
}

// ---------------------------------------------------------------------------
// Hire / tune / pause / run now
// ---------------------------------------------------------------------------

async function validateSettings(ctx: ServiceContext, companyId: string, s: HireSettings, role?: ResolvedRole): Promise<HireSettings> {
  const parsed = hireSettingsSchema.parse(s);
  let checks: ChecksConfig | undefined;
  if (parsed.checks) {
    try {
      checks = normalizeChecks(role?.engine ?? "finance", parsed.checks);
    } catch (err) {
      if (err instanceof ChecksError) throw new ServiceError("validation", err.message, { checks: [err.message] });
      throw err;
    }
  }
  const founders = new Set((await listFounders(ctx.db)).map((f) => f.id));
  for (const [field, ids] of [["recipients", parsed.recipients], ["askUserIds", parsed.askUserIds]] as const) {
    if (ids.some((id) => !founders.has(id))) {
      throw new ServiceError("validation", "An AI role only reports to and asks the founders", { [field]: ["Only the founders can be chosen"] });
    }
  }
  const keys = new Set((await companyMetricDefs(ctx.db, companyId)).map((d) => d.key));
  const unknown = parsed.requiredMetricKeys.filter((k) => !keys.has(k));
  if (unknown.length) {
    throw new ServiceError("validation", `Not a number of this company: ${unknown.join(", ")}`, { requiredMetricKeys: ["Choose numbers this company tracks"] });
  }
  if (role?.custom) {
    // A custom role waits only for numbers it watches (and so never for pay data).
    const notWatched = parsed.requiredMetricKeys.filter((k) => !role.watchedMetricKeys.includes(k));
    if (notWatched.length) {
      throw new ServiceError("validation", `The role does not watch: ${notWatched.join(", ")}`, { requiredMetricKeys: ["Choose numbers the role watches"] });
    }
  }
  const { checks: _raw, profile: rawProfile, ...rest } = parsed;
  void _raw;
  const profile = cleanProfile(rawProfile);
  return {
    ...rest,
    requiredMetricKeys: [...new Set(parsed.requiredMetricKeys)],
    recipients: [...new Set(parsed.recipients)],
    askUserIds: [...new Set(parsed.askUserIds)],
    acceptMonthlyTotals: parsed.acceptMonthlyTotals ?? false,
    ...(checks ? { checks } : {}),
    ...(profile ? { profile } : {}),
  };
}

export async function hireRole(ctx: ServiceContext, input: HireCreateInput): Promise<HireView> {
  assertAiRolesAccess(ctx);
  const data = hireCreateSchema.parse(input);
  const template = await resolveRole(ctx.db, data.templateKey);
  if (!template) throw new ServiceError("not_found", "Role not found");
  if (template.status !== "available") throw new ServiceError("validation", `${template.name} is coming soon and can't be hired yet`);
  await assertCompanyAccess(ctx, data.companyId);
  // A custom role works for its own company only (isolation).
  if (template.custom && template.companyId !== data.companyId) throw new ServiceError("validation", `${template.name} works for another company`);
  const [company] = await ctx.db.select({ slug: companies.slug, name: companies.name }).from(companies).where(eq(companies.id, data.companyId));
  const defs = await companyMetricDefs(ctx.db, data.companyId);
  const orgRules = template.engine === "org_rules";
  if (!defs.length && !orgRules) {
    throw new ServiceError("validation", `${company!.name} has no numbers yet, so the ${template.name} would have nothing to analyse`);
  }
  const founderIds = (await listFounders(ctx.db)).map((f) => f.id);
  const type = companyTypeFor(company!.slug);
  const defaults = roleDefaultSettings(template, type, founderIds);
  if (!defaults.requiredMetricKeys.length && !orgRules && !template.custom) defaults.requiredMetricKeys = [...new Set(defs.filter((d) => d.granularity === "month").map((d) => d.key))];
  // The org checks need no numbers and ask nobody: whoever gets its line is also "asked".
  if (orgRules) {
    defaults.requiredMetricKeys = [];
    if (data.settings?.recipients?.length) defaults.askUserIds = [...data.settings.recipients];
  }
  const settings = await validateSettings(ctx, data.companyId, { ...defaults, ...(data.settings ?? {}) } as HireSettings, template);
  await syncAiTemplates(ctx.db);
  const rows = await ctx.db
    .insert(aiRoleHires)
    .values({
      templateKey: template.key,
      companyId: data.companyId,
      settings,
      notes: data.notes ?? null,
      hiredBy: ctx.user.id,
      hiredOn: today(ctx),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing({ target: [aiRoleHires.templateKey, aiRoleHires.companyId] })
    .returning({ id: aiRoleHires.id });
  if (!rows[0]) throw new ServiceError("conflict", `The ${template.name} is already hired for ${company!.name} — tune it instead`);
  await logSettingsChange(ctx.db, { scope: "hire", roleKey: template.key, hireId: rows[0].id, action: "create", before: null, after: hireSnapshot(settings, data.notes ?? null), userId: ctx.user.id, now: ctx.now });
  return getHire(ctx, rows[0].id);
}

/** Tune (settings, notes) and/or pause / resume. Pausing closes the hire's data requests. */
export async function updateHire(ctx: ServiceContext, id: unknown, input: HirePatchInput, opts: { revertedTo?: number } = {}): Promise<HireView> {
  const current = await getHire(ctx, id);
  const data = hirePatchSchema.parse(input);
  const set: Partial<typeof aiRoleHires.$inferInsert> = { updatedAt: ctx.now };
  const role = await resolveRole(ctx.db, current.templateKey);
  const [stored] = await ctx.db.select({ settings: aiRoleHires.settings, notes: aiRoleHires.notes }).from(aiRoleHires).where(eq(aiRoleHires.id, current.id));
  if (data.settings) {
    // `null` in a patch clears an override (checks / profile → the role's again).
    const merged: Record<string, unknown> = { ...current.settings, ...data.settings };
    for (const k of ["checks", "profile"] as const) if (data.settings[k] === null) delete merged[k];
    set.settings = await validateSettings(ctx, current.companyId, merged as HireSettings, role ?? undefined);
  }
  if (data.notes !== undefined) set.notes = data.notes;
  if (data.status && data.status !== current.status) {
    set.status = data.status;
    set.pausedAt = data.status === "paused" ? ctx.now : null;
  }
  await ctx.db.update(aiRoleHires).set(set).where(eq(aiRoleHires.id, current.id));
  const before = hireSnapshot(stored!.settings as HireSettings, stored!.notes);
  const after = hireSnapshot((set.settings ?? stored!.settings) as HireSettings, set.notes !== undefined ? (set.notes ?? null) : stored!.notes);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await logSettingsChange(ctx.db, {
      scope: "hire",
      roleKey: current.templateKey,
      hireId: current.id,
      action: opts.revertedTo ? "revert" : "edit",
      revertedTo: opts.revertedTo,
      before,
      after,
      userId: ctx.user.id,
      now: ctx.now,
    });
  }
  if (data.status === "paused") {
    await ctx.db
      .update(aiDataRequests)
      .set({ status: "cancelled", reason: "paused", resolvedAt: ctx.now })
      .where(and(eq(aiDataRequests.hireId, current.id), eq(aiDataRequests.status, "active")));
  } else if (set.settings) {
    await recheckOpenRuns(ctx.db, current.id, ctx.now, today(ctx));
  }
  return getHire(ctx, current.id);
}

/**
 * After a settings change (a hire's, or its role's): re-checks the runs that are not done
 * with the new settings (the numbers needed may have changed) and keeps the data requests
 * in step. Reports already made stay as they are ("Settings changed" on the report).
 */
export async function recheckOpenRuns(db: Db, hireId: string, now: Date, todayIso: IsoDate): Promise<void> {
  const hc = await hireContext(db, hireId);
  if (!hc || hc.hire.status !== "active" || !runBased(hc.template.engine)) return;
  const open = await db
    .select()
    .from(aiRoleRuns)
    .where(and(eq(aiRoleRuns.hireId, hireId), inArray(aiRoleRuns.status, ["waiting_for_data", "failed"])));
  for (const run of open) await evaluateRun(db, hc, run, now);
  await syncDataRequests(db, hc, todayIso, now);
}

/**
 * "Run now": checks last month's numbers right away (whatever the schedule day) and, when
 * complete, analyses and reports. Returns the run. A paused role can't run.
 */
export async function runHireNow(ctx: ServiceContext, hireId: unknown, opts: EngineOptions = {}): Promise<RunView> {
  const view = await getHire(ctx, hireId);
  if (view.status !== "active") throw new ServiceError("validation", "This role is paused — resume it first");
  const hc = (await hireContext(ctx.db, view.id))!;
  if (!runBased(hc.template.engine)) {
    throw new ServiceError("validation", `The ${hc.template.name} has no monthly report: its checks are live on the Org structure page`);
  }
  const period = prevMonth(monthStart(today(ctx)));
  const run = await ensureRun(ctx.db, view.id, period, "manual", ctx.now);
  await evaluateRun(ctx.db, hc, run, ctx.now, { timeZone: ctx.timeZone, ...opts });
  return getRun(ctx, run.id);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export async function getRun(ctx: ServiceContext, id: unknown): Promise<RunView> {
  assertAiRolesAccess(ctx);
  assertValidId(id, "Report");
  const [run] = await ctx.db.select().from(aiRoleRuns).where(eq(aiRoleRuns.id, id));
  if (!run) throw new ServiceError("not_found", "Report not found");
  const hire = await getHire(ctx, run.hireId).catch(() => null);
  if (!hire) throw new ServiceError("not_found", "Report not found");
  const defs = await companyMetricDefs(ctx.db, hire.companyId);
  const fromHolding = run.missing.filter((m) => holdingFed({ key: m.key, sourceKind: defs.find((d) => d.id === m.metricId)?.sourceKind })).map((m) => m.metricId);
  const firstMissing = defs.find((d) => d.id === run.missing.find((m) => !fromHolding.includes(m.metricId))?.metricId);
  let inputsChanged = false;
  let settingsChanged = false;
  const hc = (run.status === "reported" || run.status === "analysed") && run.inputsHash ? await hireContext(ctx.db, hire.id) : null;
  if (hc) {
    const history = historyMonthsFor(hc.analysis);
    const ev = evaluateNumbers(
      await loadCompanyNumbers(ctx.db, hire.companyId, monthsFor(run.period, history), hc.template),
      run.period,
      hire.settings.requiredMetricKeys,
      hire.settings.acceptMonthlyTotals,
      history,
    );
    if (!ev.missing.length) {
      const drift = reportDrift(run, ev.inputs, hire.settings, analysisKey(hc));
      inputsChanged = drift.inputs;
      settingsChanged = drift.settings;
    }
  }
  return {
    ...runSummary(run),
    hire: {
      id: hire.id,
      roleName: hire.roleName,
      companyId: hire.companyId,
      companySlug: hire.companySlug,
      companyName: hire.companyName,
      companyColor: hire.companyColor,
      status: hire.status,
      settings: hire.settings,
    },
    missing: run.missing,
    findings: findingsOf(run),
    inputs: run.inputs ?? null,
    narrative: run.narrative,
    narrativeStatus: run.narrativeStatus,
    narrativeOmitted: findingsOf(run).filter((f) => salaryLikeFinding(f, payKeysOf(defs))).length,
    provider: run.provider,
    error: run.error,
    trigger: run.trigger,
    analysedAt: run.analysedAt?.toISOString() ?? null,
    numbersHref: numbersHref(hire.companySlug, firstMissing?.granularity ?? "month"),
    missingFromHolding: fromHolding,
    inputsChanged,
    settingsChanged,
    monthTotalEntry: hire.settings.acceptMonthlyTotals
      ? Object.fromEntries(
          run.missing.flatMap((m) => {
            const d = defs.find((x) => x.id === m.metricId);
            return d && d.granularity === "day" && !fromHolding.includes(d.id) ? [[d.id, monthTotalKind(d.aggregation)]] : [];
          }),
        )
      : {},
  };
}

/**
 * The report's "missing" list: enter the month total (average, end-of-month value) of a daily
 * number for the report's month, then check the numbers again. Only for a number the run is
 * missing, of the hire's own company, when the role accepts monthly totals.
 */
export async function enterMonthTotalForRun(ctx: ServiceContext, runId: unknown, metricId: string, value: unknown): Promise<RunView> {
  const view = await getRun(ctx, runId);
  if (!view.monthTotalEntry[metricId]) {
    throw new ServiceError("validation", view.hire.settings.acceptMonthlyTotals
      ? "A month total can be entered here only for a missing daily number of this report"
      : "This role counts daily numbers only with every day in — turn on “Accept monthly totals” in Tune first");
  }
  await recordMonthTotal(ctx, metricId, { month: view.period, value });
  if (view.hire.status !== "active") return getRun(ctx, view.id);
  return rerunReport(ctx, view.id);
}

/**
 * "Run again" on a report: re-checks that month's numbers now. A report already made is
 * re-analysed only when its numbers (or the role's settings) changed, and never pushed again.
 */
export async function rerunReport(ctx: ServiceContext, runId: unknown, opts: EngineOptions = {}): Promise<RunView> {
  const view = await getRun(ctx, runId);
  if (view.hire.status !== "active") throw new ServiceError("validation", "This role is paused — resume it first");
  const hc = (await hireContext(ctx.db, view.hire.id))!;
  const [run] = await ctx.db.select().from(aiRoleRuns).where(eq(aiRoleRuns.id, view.id));
  await evaluateRun(ctx.db, hc, run!, ctx.now, { timeZone: ctx.timeZone, ...opts });
  return getRun(ctx, view.id);
}

/**
 * "Create task" on a risk finding: a shared task for the company, created by the founder who
 * clicked (never automatically). Clicking twice (or both founders at once) gives one task.
 */
export async function createTaskFromFinding(ctx: ServiceContext, runId: unknown, findingId: string): Promise<{ taskId: string; created: boolean }> {
  const view = await getRun(ctx, runId);
  return ctx.db.transaction(async (tx) => {
    const [run] = await tx.select().from(aiRoleRuns).where(eq(aiRoleRuns.id, view.id)).for("update");
    const findings = findingsOf(run!);
    const finding = findings.find((f) => f.id === findingId);
    if (!finding) throw new ServiceError("not_found", "Finding not found");
    if (finding.severity !== "risk") throw new ServiceError("validation", "Tasks are created from risk findings only");
    if (finding.taskId) return { taskId: finding.taskId, created: false };
    const txCtx = { ...ctx, db: tx as unknown as Db };
    const title = `${view.hire.roleName}: ${finding.sentence}`.slice(0, 300);
    const task = await createTask(txCtx, {
      title,
      notes: `From the ${view.hire.roleName} report for ${view.hire.companyName} · ${view.periodLabel}: ${appUrl(`/ai-roles/runs/${view.id}`)}`,
      companyId: view.hire.companyId,
      visibility: "shared",
      priority: "high",
    });
    finding.taskId = task.id;
    await tx.update(aiRoleRuns).set({ findings }).where(eq(aiRoleRuns.id, view.id));
    return { taskId: task.id, created: true };
  });
}

/** The "report ready" push (built at send time as the recipient; null when the report is gone). */
export async function buildReportReadyMessage(ctx: ServiceContext, runId: string): Promise<NeutralMessage | null> {
  const run = await getRun(ctx, runId).catch(() => null);
  if (!run || (run.status !== "reported" && run.status !== "analysed")) return null;
  const top = run.findings.filter((f) => f.severity !== "info").slice(0, 3);
  return {
    title: `${run.hire.roleName}: report ready`,
    lines: [
      { text: `${run.hire.companyName} · ${run.periodLabel}`, style: "text" },
      { text: run.summary, style: "text" },
      ...top.map((f) => ({ text: f.sentence, style: "item" as const })),
      { text: `Open the report: ${appUrl(`/ai-roles/runs/${run.id}`)}`, style: "muted" },
    ],
  };
}

/** One line for a parked "report ready" push inside the next summary. */
export async function reportParkedLine(ctx: ServiceContext, runId: string): Promise<string | null> {
  const run = await getRun(ctx, runId).catch(() => null);
  if (!run) return null;
  return `Report ready: ${run.hire.roleName} · ${run.hire.companyName} · ${run.periodLabel} (${run.summary}) — ${appUrl(`/ai-roles/runs/${run.id}`)}`;
}

// ---------------------------------------------------------------------------
// Agent panel
// ---------------------------------------------------------------------------

export interface AgentPanelHire {
  id: string;
  roleName: string;
  companySlug: string;
  companyName: string;
  status: "active" | "paused";
  latestRun: { id: string; periodLabel: string; status: AiRunStatus; summary: string } | null;
}

/** Hired roles and their latest report links for the right slide-out agent panel. */
export async function agentPanelHires(ctx: ServiceContext): Promise<AgentPanelHire[]> {
  if (ctx.user.role !== "founder") return [];
  const hires = await listHires(ctx);
  return hires.map((h) => ({
    id: h.id,
    roleName: h.roleName,
    companySlug: h.companySlug,
    companyName: h.companyName,
    status: h.status,
    latestRun: h.latestRun ? { id: h.latestRun.id, periodLabel: h.latestRun.periodLabel, status: h.latestRun.status, summary: h.latestRun.summary } : null,
  }));
}

/** Days a run's month is checked before its data request appears (for the UI). */
export function requestDueOn(period: IsoDate, settings: HireSettings): IsoDate {
  return runDueOn(period, settings.schedule);
}

export { periodsInMonth };

/** What a hire's settings log stores per version: its settings and notes. */
function hireSnapshot(settings: HireSettings, notes: string | null): Record<string, unknown> {
  return { settings, notes };
}
