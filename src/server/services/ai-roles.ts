import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import {
  addMonths,
  chaseDueToday,
  companyTypeFor,
  defaultSettings,
  firstPeriodFor,
  hireCreateSchema,
  hirePatchSchema,
  hireSettingsSchema,
  monthLabel,
  prevMonth,
  monthStart,
  runDueOn,
  scheduledPeriod,
  scheduleLabel,
  templateByKey,
  ROLE_TEMPLATES,
  type CompanyType,
  type HireCreateInput,
  type HirePatchInput,
  type HireSettings,
  type RoleTemplate,
} from "@/lib/ai-roles";
import { addDays, todayInTimeZone, type IsoDate } from "@/lib/dates";
import { analyseFinance, countBySeverity, severitySummary, type Finding, type MonthSeries, type Severity } from "@/server/ai/finance-rules";
import { monthValue, periodsInMonth, type Granularity } from "@/server/ai/month-values";
import { generateNarrative } from "@/server/ai/narrative";
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
import { listFounders } from "@/server/notifications/founders";
import { enqueue } from "@/server/notifications/outbox";
import type { NeutralMessage } from "@/server/notifications/types";
import { assertAiRolesAccess, assertCompanyAccess, assertValidId } from "./access";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
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
}

export interface HireView {
  id: string;
  templateKey: string;
  roleName: string;
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
  provider: string | null;
  error: string | null;
  trigger: string;
  analysedAt: string | null;
  /** Deep link to enter the missing numbers. */
  numbersHref: string;
  /** A report was made, but its numbers were corrected since ("Run again" re-analyses). */
  inputsChanged: boolean;
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
          ? "Failed — will retry"
          : severitySummary(f),
    reportedAt: run.reportedAt?.toISOString() ?? null,
  };
}

/** Settings as stored, completed with defaults (older rows, partial input). */
function settingsOf(hire: Pick<AiRoleHire, "settings">, template: RoleTemplate, type: CompanyType, founderIds: string[]): HireSettings {
  const d = defaultSettings(template, type, founderIds);
  const s = (hire.settings ?? {}) as Partial<AiHireSettingsJson>;
  return {
    schedule: s.schedule ?? d.schedule,
    thresholds: s.thresholds ?? d.thresholds,
    requiredMetricKeys: s.requiredMetricKeys ?? d.requiredMetricKeys,
    recipients: s.recipients ?? d.recipients,
    askUserIds: s.askUserIds ?? d.askUserIds,
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
  return rows.map(({ hire, companySlug, companyName, companyColor, hiredByName }) => {
    const template = templateByKey(hire.templateKey)!;
    const type = companyTypeFor(companySlug);
    const settings = settingsOf(hire, template, type, founderIds);
    const latest = runs.find((r) => r.hireId === hire.id);
    return {
      id: hire.id,
      templateKey: hire.templateKey,
      roleName: template?.name ?? hire.templateKey,
      companyId: hire.companyId,
      companySlug,
      companyName,
      companyColor,
      companyType: type,
      status: hire.status,
      settings,
      scheduleLabel: scheduleLabel(settings.schedule),
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
  unitSlug: string | null;
  aggregation: "sum" | "avg" | "last";
  direction: "higher_is_better" | "lower_is_better" | "neutral";
  target: string | null;
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
    label: unitName ? `${d.name} · ${unitName}` : d.name,
    unit: d.unit,
    unitSlug: unitSlug ?? null,
    granularity: d.granularity,
    aggregation: d.aggregation,
    direction: d.direction,
    target: d.target,
  }));
}

/** The metrics a role can wait for in this company (for the Tune wizard), one entry per key. */
export async function companyMetricOptions(ctx: ServiceContext, companyId: string): Promise<{ key: string; label: string; granularity: Granularity; unit: string }[]> {
  assertAiRolesAccess(ctx);
  assertValidId(companyId, "Company");
  await assertCompanyAccess(ctx, companyId);
  const defs = await companyMetricDefs(ctx.db, companyId);
  const byKey = new Map<string, { key: string; label: string; granularity: Granularity; unit: string }>();
  for (const d of defs) if (!byKey.has(d.key)) byKey.set(d.key, { key: d.key, label: d.name, granularity: d.granularity, unit: d.unit });
  return [...byKey.values()];
}

interface CompanyNumbers {
  defs: MetricDef[];
  /** metricId → period start → decimal text (current values only). */
  values: Map<string, Map<IsoDate, string>>;
  /** metricIds that have any value before the window. */
  hadEarlier: Set<string>;
}

async function loadCompanyNumbers(db: Db, companyId: string, months: IsoDate[]): Promise<CompanyNumbers> {
  const defs = await companyMetricDefs(db, companyId);
  const values = new Map<string, Map<IsoDate, string>>();
  const hadEarlier = new Set<string>();
  if (!defs.length) return { defs, values, hadEarlier };
  const from = months[0]!;
  const to = addDays(addMonths(months.at(-1)!, 1), -1);
  const rows = await db
    .select({ metricId: metricValues.metricId, period: metricValues.periodStart, value: metricValues.value })
    .from(metricValues)
    .where(
      and(
        inArray(metricValues.metricId, defs.map((d) => d.id)),
        eq(metricValues.isCurrent, true),
        sql`${metricValues.periodStart} between ${from} and ${to}`,
      ),
    );
  for (const r of rows) {
    const m = values.get(r.metricId) ?? new Map<IsoDate, string>();
    m.set(r.period, r.value);
    values.set(r.metricId, m);
  }
  const earlier = await db
    .selectDistinct({ metricId: metricValues.metricId })
    .from(metricValues)
    .where(and(inArray(metricValues.metricId, defs.map((d) => d.id)), eq(metricValues.isCurrent, true), lt(metricValues.periodStart, from)));
  for (const e of earlier) hadEarlier.add(e.metricId);
  return { defs, values, hadEarlier };
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

function evaluateNumbers(numbers: CompanyNumbers, period: IsoDate, required: readonly string[]): Evaluation {
  const months = Array.from({ length: HISTORY_MONTHS + 1 }, (_, i) => prevMonth(period, HISTORY_MONTHS - i));
  const missing: AiRunMissing[] = [];
  const series: MonthSeries[] = [];
  const inputs: AiRunInputs = { months, metrics: [] };
  for (const d of numbers.defs) {
    const vals = numbers.values.get(d.id) ?? new Map<IsoDate, string>();
    const monthVals: Record<IsoDate, string | null> = {};
    for (const m of months) {
      const mv = monthValue(d, vals, m);
      monthVals[m] = "value" in mv ? cleanDecimal(mv.value) : null;
      if (m === period && required.includes(d.key) && !("value" in mv)) {
        const detail =
          d.granularity === "month"
            ? "no value"
            : mv.missing === mv.total
              ? `no values (${mv.total} ${d.granularity === "day" ? "days" : "weeks"})`
              : `${mv.missing} of ${mv.total} ${d.granularity === "day" ? "days" : "weeks"} missing`;
        missing.push({ metricId: d.id, key: d.key, label: d.label, detail });
      }
    }
    series.push({
      metricId: d.id,
      key: d.key,
      name: d.name,
      label: d.label,
      unitSlug: d.unitSlug,
      unit: d.unit,
      direction: d.direction,
      target: d.target === null ? null : cleanDecimal(d.target),
      months: monthVals,
      everHadData: numbers.hadEarlier.has(d.id) || vals.size > 0,
    });
    inputs.metrics.push({ metricId: d.id, key: d.key, label: d.label, unit: d.unit, values: months.map((m) => monthVals[m] ?? null) });
  }
  return { missing, inputs, series };
}

function hashInputs(inputs: AiRunInputs, required: readonly string[], thresholds: HireSettings["thresholds"]): string {
  return createHash("sha256").update(JSON.stringify({ inputs, required: [...required].sort(), thresholds })).digest("hex");
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
  template: RoleTemplate;
  settings: HireSettings;
  companyName: string;
  companySlug: string;
}

async function hireContext(db: Db, hireId: string): Promise<HireContext | null> {
  const [row] = await loadHireRows(db, eq(aiRoleHires.id, hireId));
  if (!row) return null;
  const template = templateByKey(row.hire.templateKey);
  if (!template) return null;
  const founderIds = (await listFounders(db)).map((f) => f.id);
  return {
    hire: row.hire,
    template,
    settings: settingsOf(row.hire, template, companyTypeFor(row.companySlug), founderIds),
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
    const months = Array.from({ length: HISTORY_MONTHS + 1 }, (_, i) => prevMonth(run.period, HISTORY_MONTHS - i));
    const numbers = await loadCompanyNumbers(db, hc.hire.companyId, months);
    const ev = evaluateNumbers(numbers, run.period, required);
    if (ev.missing.length) {
      // A report already made stays (numbers were removed / settings changed later): only a
      // run that has not been analysed goes (back) to waiting.
      if (run.status === "analysed" || run.status === "reported") return run;
      return update({ status: "waiting_for_data", missing: ev.missing, error: null });
    }
    const hash = hashInputs(ev.inputs, required, hc.settings.thresholds);
    let current = run;
    if (!((run.status === "analysed" || run.status === "reported") && run.inputsHash === hash)) {
      if (run.status !== "analysed" && run.status !== "reported") current = await update({ status: "ready", missing: [], error: null });
      const findings = (opts.analyse ?? analyseFinance)({
        companyName: hc.companyName,
        period: run.period,
        series: ev.series,
        thresholds: hc.settings.thresholds,
      });
      // Keep tasks already created from a finding that is still there.
      const previous = new Map(findingsOf(run).map((f) => [f.id, f.taskId]));
      for (const f of findings) if (previous.get(f.id)) f.taskId = previous.get(f.id);
      const narrative = await generateNarrative(
        { roleName: hc.template.name, companyName: hc.companyName, periodLabel: monthLabel(run.period), findings },
        opts.provider ?? getLlmProvider(),
      );
      current = await update({
        status: current.status === "reported" ? "reported" : "analysed",
        missing: [],
        inputs: ev.inputs,
        inputsHash: hash,
        findings,
        narrative: narrative.text,
        narrativeStatus: narrative.status,
        provider: narrative.provider,
        error: null,
        analysedAt: now,
      });
    }
    if (current.status === "analysed") {
      await queueReportPushes(db, hc, current, now);
      current = await update({ status: "reported", reportedAt: current.reportedAt ?? now });
    }
    return current;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-roles] run ${run.id} failed: ${message}`);
    return update({ status: "failed", error: message.slice(0, 500) });
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
      const period = scheduledPeriod(todayIso, hc.settings.schedule);
      if (period >= firstPeriodFor(hc.hire.hiredOn)) {
        const [exists] = await db.select({ id: aiRoleRuns.id }).from(aiRoleRuns).where(and(eq(aiRoleRuns.hireId, id), eq(aiRoleRuns.period, period)));
        if (!exists) {
          await ensureRun(db, id, period, "schedule", now);
          report.runsCreated++;
        }
      }
      const open = await db
        .select()
        .from(aiRoleRuns)
        .where(and(eq(aiRoleRuns.hireId, id), inArray(aiRoleRuns.status, ["waiting_for_data", "ready", "analysed", "failed"])))
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
      .onConflictDoNothing({ target: [aiDataRequests.hireId, aiDataRequests.userId, aiDataRequests.roundKey] })
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
  /** Missing numbers across those months (one entry per metric). */
  missing: { metricId: string; key: string; label: string; granularity: Granularity }[];
  /** True when today is one of the request's chase days (daily for 7 days, then weekly). */
  dueToday: boolean;
}

export function appUrl(path: string): string {
  const base = process.env.APP_URL?.trim().replace(/\/+$/, "");
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
export async function collectAiRequests(ctx: ServiceContext): Promise<AiRequestItem[]> {
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
    for (const run of waiting) {
      for (const m of run.missing) {
        if (missing.some((x) => x.metricId === m.metricId)) continue;
        missing.push({ metricId: m.metricId, key: m.key, label: m.label, granularity: defs.get(m.metricId)?.granularity ?? "month" });
      }
    }
    out.push({
      requestId: r.id,
      hireId: r.hireId,
      roleName: hc.template.name,
      companyName: hc.companyName,
      companySlug: hc.companySlug,
      months: waiting.map((w) => w.period),
      missing,
      dueToday: chaseDueToday(r.createdOn, r.lastShownOn, todayIso),
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

async function validateSettings(ctx: ServiceContext, companyId: string, s: HireSettings): Promise<HireSettings> {
  const parsed = hireSettingsSchema.parse(s);
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
  return {
    ...parsed,
    requiredMetricKeys: [...new Set(parsed.requiredMetricKeys)],
    recipients: [...new Set(parsed.recipients)],
    askUserIds: [...new Set(parsed.askUserIds)],
  };
}

export async function hireRole(ctx: ServiceContext, input: HireCreateInput): Promise<HireView> {
  assertAiRolesAccess(ctx);
  const data = hireCreateSchema.parse(input);
  const template = templateByKey(data.templateKey);
  if (!template) throw new ServiceError("not_found", "Role not found");
  if (template.status !== "available") throw new ServiceError("validation", `${template.name} is coming soon and can't be hired yet`);
  await assertCompanyAccess(ctx, data.companyId);
  const [company] = await ctx.db.select({ slug: companies.slug, name: companies.name }).from(companies).where(eq(companies.id, data.companyId));
  const defs = await companyMetricDefs(ctx.db, data.companyId);
  if (!defs.length) {
    throw new ServiceError("validation", `${company!.name} has no numbers yet, so the ${template.name} would have nothing to analyse`);
  }
  const founderIds = (await listFounders(ctx.db)).map((f) => f.id);
  const type = companyTypeFor(company!.slug);
  const defaults = defaultSettings(template, type, founderIds);
  if (!defaults.requiredMetricKeys.length) defaults.requiredMetricKeys = [...new Set(defs.filter((d) => d.granularity === "month").map((d) => d.key))];
  const settings = await validateSettings(ctx, data.companyId, { ...defaults, ...(data.settings ?? {}) } as HireSettings);
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
  return getHire(ctx, rows[0].id);
}

/** Tune (settings, notes) and/or pause / resume. Pausing closes the hire's data requests. */
export async function updateHire(ctx: ServiceContext, id: unknown, input: HirePatchInput): Promise<HireView> {
  const current = await getHire(ctx, id);
  const data = hirePatchSchema.parse(input);
  const set: Partial<typeof aiRoleHires.$inferInsert> = { updatedAt: ctx.now };
  if (data.settings) set.settings = await validateSettings(ctx, current.companyId, { ...current.settings, ...data.settings } as HireSettings);
  if (data.notes !== undefined) set.notes = data.notes;
  if (data.status && data.status !== current.status) {
    set.status = data.status;
    set.pausedAt = data.status === "paused" ? ctx.now : null;
  }
  await ctx.db.update(aiRoleHires).set(set).where(eq(aiRoleHires.id, current.id));
  if (data.status === "paused") {
    await ctx.db
      .update(aiDataRequests)
      .set({ status: "cancelled", reason: "paused", resolvedAt: ctx.now })
      .where(and(eq(aiDataRequests.hireId, current.id), eq(aiDataRequests.status, "active")));
  } else if (set.settings) {
    const hc = await hireContext(ctx.db, current.id);
    if (hc && hc.hire.status === "active") {
      // Re-check runs that are not done with the new settings (numbers needed may have changed).
      const open = await ctx.db
        .select()
        .from(aiRoleRuns)
        .where(and(eq(aiRoleRuns.hireId, current.id), inArray(aiRoleRuns.status, ["waiting_for_data", "failed"])));
      for (const run of open) await evaluateRun(ctx.db, hc, run, ctx.now);
      await syncDataRequests(ctx.db, hc, today(ctx), ctx.now);
    }
  }
  return getHire(ctx, current.id);
}

/**
 * "Run now": checks last month's numbers right away (whatever the schedule day) and, when
 * complete, analyses and reports. Returns the run. A paused role can't run.
 */
export async function runHireNow(ctx: ServiceContext, hireId: unknown, opts: EngineOptions = {}): Promise<RunView> {
  const view = await getHire(ctx, hireId);
  if (view.status !== "active") throw new ServiceError("validation", "This role is paused — resume it first");
  const hc = (await hireContext(ctx.db, view.id))!;
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
  const firstMissing = defs.find((d) => d.id === run.missing[0]?.metricId);
  let inputsChanged = false;
  if ((run.status === "reported" || run.status === "analysed") && run.inputsHash) {
    const months = Array.from({ length: HISTORY_MONTHS + 1 }, (_, i) => prevMonth(run.period, HISTORY_MONTHS - i));
    const ev = evaluateNumbers(await loadCompanyNumbers(ctx.db, hire.companyId, months), run.period, hire.settings.requiredMetricKeys);
    inputsChanged = !ev.missing.length && hashInputs(ev.inputs, hire.settings.requiredMetricKeys, hire.settings.thresholds) !== run.inputsHash;
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
    provider: run.provider,
    error: run.error,
    trigger: run.trigger,
    analysedAt: run.analysedAt?.toISOString() ?? null,
    numbersHref: numbersHref(hire.companySlug, firstMissing?.granularity ?? "month"),
    inputsChanged,
  };
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
  return `Report ready: ${run.hire.roleName} · ${run.hire.companyName} · ${run.periodLabel} (${run.summary})`;
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
