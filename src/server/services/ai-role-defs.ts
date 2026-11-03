import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import {
  CHECK_CATALOGUE,
  defaultChecks,
  normalizeChecks,
  roleConfigSchema,
  type ChecksConfig,
  type RatioCheck,
  type RoleConfig,
  type RoleEngine,
} from "@/lib/ai-role-config";
import {
  defaultSettings,
  ROLE_TEMPLATES,
  templateByKey,
  templateEngine,
  type CompanyType,
  type HireSettings,
  type RoleTemplate,
} from "@/lib/ai-roles";
import { ALLOWED_PAY_KEYS, isSalaryText } from "@/server/ai/narrative";
import type { Db } from "@/server/db/connect";
import { aiRoleConfigs, aiRoleSettingsLog, type AiRoleHire } from "@/server/db/schema";

/**
 * AI roles as the founders tuned them: the code catalogue (src/lib/ai-roles.ts) with their
 * role-level edits applied (name, job description, responsibilities, instructions, default
 * schedule / recipients, check defaults — table ai_role_configs), plus the custom roles they
 * made. No access checks here: callers are the AI role services, which check first.
 */

export const CUSTOM_PREFIX = "custom-";
export const isCustomKey = (key: string) => key.startsWith(CUSTOM_PREFIX);

export interface ResolvedRole extends RoleTemplate {
  engine: RoleEngine;
  custom: boolean;
  /** Custom roles: the company it works for. */
  companyId: string | null;
  /** Custom roles copied from a built-in role. */
  basedOn: string | null;
  /** The stored role-level settings ({} when never edited). */
  config: RoleConfig;
  version: number;
  instructions: string | null;
  /** Role-level checks (saved, or the catalogue's defaults). */
  checks: ChecksConfig;
  /** Custom roles: numbers it watches. */
  watchedMetricKeys: string[];
  ratioChecks: RatioCheck[];
  /** The code template (built-in roles), unchanged. */
  base: RoleTemplate | null;
}

const CUSTOM_REPORT_SECTIONS = ["Risks", "Warnings", "Info", "Numbers used", "AI summary (after the AI provider is chosen)"];

type ConfigRow = typeof aiRoleConfigs.$inferSelect;

function parseConfig(raw: unknown): RoleConfig {
  const r = roleConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : {};
}

function safeChecks(engine: RoleEngine, raw: unknown): ChecksConfig {
  try {
    return normalizeChecks(engine, raw);
  } catch {
    return defaultChecks(engine);
  }
}

export function resolveFrom(key: string, row: ConfigRow | undefined): ResolvedRole | null {
  const config = parseConfig(row?.config);
  const base = templateByKey(key) ?? null;
  if (base) {
    const engine = templateEngine(base);
    return {
      ...base,
      name: config.profile?.name ?? base.name,
      description: config.profile?.description ?? base.description,
      responsibilities: config.profile?.responsibilities ?? base.responsibilities,
      defaultSchedule: config.schedule ?? base.defaultSchedule,
      engine,
      custom: false,
      companyId: null,
      basedOn: null,
      config,
      version: row?.version ?? 0,
      instructions: config.profile?.instructions ?? null,
      checks: safeChecks(engine, config.checks),
      watchedMetricKeys: [],
      ratioChecks: [],
      base,
    };
  }
  if (!row || row.kind !== "custom") return null;
  return {
    key,
    name: config.profile?.name ?? "Custom role",
    description: config.profile?.description ?? "",
    status: "available",
    responsibilities: config.profile?.responsibilities ?? [],
    requiredData: {},
    optionalUploads: [],
    defaultSchedule: config.schedule ?? { kind: "monthly", day: 10 },
    reportSections: CUSTOM_REPORT_SECTIONS,
    sort: 1000,
    engine: "custom",
    custom: true,
    companyId: row.companyId,
    basedOn: row.basedOn,
    config,
    version: row.version,
    instructions: config.profile?.instructions ?? null,
    checks: safeChecks("custom", config.checks),
    watchedMetricKeys: config.watchedMetricKeys ?? [],
    ratioChecks: config.ratioChecks ?? [],
    base: null,
  };
}

export async function loadConfigRows(db: Db): Promise<Map<string, ConfigRow>> {
  const rows = await db.select().from(aiRoleConfigs).orderBy(asc(aiRoleConfigs.createdAt));
  return new Map(rows.map((r) => [r.key, r]));
}

export async function resolveRole(db: Db, key: string): Promise<ResolvedRole | null> {
  const [row] = await db.select().from(aiRoleConfigs).where(eq(aiRoleConfigs.key, key));
  return resolveFrom(key, row);
}

/** Every role: the built-in catalogue (with edits) then the custom roles (oldest first). */
export async function resolveAllRoles(db: Db): Promise<ResolvedRole[]> {
  const rows = await loadConfigRows(db);
  const builtIn = [...ROLE_TEMPLATES].sort((a, b) => a.sort - b.sort).map((t) => resolveFrom(t.key, rows.get(t.key))!);
  const custom = [...rows.values()].filter((r) => r.kind === "custom").map((r) => resolveFrom(r.key, r)!);
  return [...builtIn, ...custom];
}

/** A new hire's settings: the role's defaults (schedule, recipients, thresholds, numbers). */
export function roleDefaultSettings(role: ResolvedRole, type: CompanyType, founderIds: readonly string[]): HireSettings {
  const d = defaultSettings(role, type, founderIds);
  const recipients = (role.config.recipients ?? []).filter((id) => founderIds.includes(id));
  if (recipients.length) {
    d.recipients = recipients;
    d.askUserIds = [...recipients];
  }
  const cp = role.checks.change_prev;
  if (cp && typeof cp.warnPct === "number" && typeof cp.riskPct === "number") d.thresholds = { changePct: cp.warnPct, riskChangePct: cp.riskPct };
  if (role.custom) d.requiredMetricKeys = role.config.requiredMetricKeys ?? [...role.watchedMetricKeys];
  const heads = role.checks.head_overloaded?.maxDepartments;
  if (role.engine === "org_rules" && typeof heads === "number" && heads !== 4) d.maxDepartmentsPerHead = heads;
  return d;
}

/**
 * A hire's effective checks: its own (when saved) or the role's, with the values that have
 * always lived in the hire's settings filled in — the "vs the month before" thresholds
 * (`thresholds`) and the Org Expert's head limit (`maxDepartmentsPerHead`).
 */
export function hireChecks(role: Pick<ResolvedRole, "engine" | "checks">, settings: Pick<HireSettings, "checks" | "thresholds" | "maxDepartmentsPerHead">): ChecksConfig {
  const checks = settings.checks ? safeChecks(role.engine, settings.checks) : structuredClone(role.checks);
  if (checks.change_prev) {
    checks.change_prev.warnPct = settings.thresholds.changePct;
    checks.change_prev.riskPct = settings.thresholds.riskChangePct;
  }
  if (checks.head_overloaded) checks.head_overloaded.maxDepartments = settings.maxDepartmentsPerHead ?? (checks.head_overloaded.maxDepartments as number | null) ?? 4;
  return checks;
}

/** Org checks a hire turned off (for orgExpertFindings). */
export function disabledOrgRules(checks: ChecksConfig): string[] {
  return CHECK_CATALOGUE.org_rules.filter((c) => checks[c.id] && !checks[c.id]!.enabled).map((c) => c.id);
}

/**
 * Pay data a custom role may never watch: a metric whose key, name or aliases name salaries /
 * payroll / wages (the narrative's word list), unless its key is on the allow-list
 * (`piecework_total`, a factory total).
 */
export function isSalaryMetric(def: { key: string; name: string; aliases?: readonly string[] }): boolean {
  if (ALLOWED_PAY_KEYS.has(def.key)) return false;
  return [def.key, def.name, ...(def.aliases ?? [])].some((t) => isSalaryText(t));
}

/** The hire's role name (its own override, else the role's). */
export function hireRoleName(role: Pick<ResolvedRole, "name">, hire: Pick<AiRoleHire, "settings">): string {
  return hire.settings?.profile?.name || role.name;
}

/**
 * Logs one version of a role's or a hire's settings (who / when / before / after). Versions
 * are numbered per scope; two edits at the same moment get consecutive numbers (unique index,
 * retried). Returns the new version.
 */
export async function logSettingsChange(
  db: Db,
  e: {
    scope: "role" | "hire";
    roleKey: string;
    hireId?: string | null;
    action: "create" | "edit" | "revert";
    revertedTo?: number;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
    userId: string;
    now: Date;
  },
): Promise<number> {
  const scopeKey = e.scope === "hire" ? `hire:${e.hireId}` : `role:${e.roleKey}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [top] = await db
      .select({ v: sql<number>`coalesce(max(${aiRoleSettingsLog.version}), 0)::int` })
      .from(aiRoleSettingsLog)
      .where(eq(aiRoleSettingsLog.scopeKey, scopeKey));
    const version = Number(top?.v ?? 0) + 1;
    const rows = await db
      .insert(aiRoleSettingsLog)
      .values({
        scopeKey,
        roleKey: e.roleKey,
        hireId: e.scope === "hire" ? (e.hireId ?? null) : null,
        version,
        action: e.action,
        revertedTo: e.revertedTo ?? null,
        before: e.before,
        after: e.after,
        changedBy: e.userId,
        createdAt: e.now,
      })
      .onConflictDoNothing({ target: [aiRoleSettingsLog.scopeKey, aiRoleSettingsLog.version] })
      .returning({ version: aiRoleSettingsLog.version });
    if (rows[0]) return rows[0].version;
  }
  throw new Error("Could not number the settings version (too many edits at once) — try again");
}
