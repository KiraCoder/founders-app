import "server-only";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  CHECK_CATALOGUE,
  ChecksError,
  cleanProfile,
  customRoleCreateSchema,
  normalizeChecks,
  roleConfigSchema,
  type ChecksConfig,
  type CustomRoleCreateInput,
  type RoleConfig,
} from "@/lib/ai-role-config";
import { companyTypeFor, requiredKeysFor, templateByKey, templateEngine, type HireSettings } from "@/lib/ai-roles";
import type { Db } from "@/server/db/connect";
import { aiRoleConfigs, aiRoleHires, aiRoleSettingsLog, aiRoleTemplates, companies, metricDefinitions, users } from "@/server/db/schema";
import { listFounders } from "@/server/notifications/founders";
import { assertAiRolesAccess, assertCompanyAccess, assertValidId } from "./access";
import { CUSTOM_PREFIX, isCustomKey, isSalaryMetric, logSettingsChange, resolveRole, type ResolvedRole } from "./ai-role-defs";
import { recheckOpenRuns, updateHire, type HireView } from "./ai-roles";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";

/**
 * The AI role editor ("tune AI inside the cockpit"), founders only:
 * - edit a role at template level (built-in: name, job description, responsibilities, your
 *   instructions, default schedule / recipients, check defaults; custom: its whole definition);
 * - create a custom role from scratch or by copying a built-in role;
 * - every edit is a numbered version (who / when / before / after) and can be reverted.
 * Per-hire overrides go through `updateHire` (services/ai-roles.ts), which logs the same way.
 */

export interface SettingsVersion {
  version: number;
  action: "create" | "edit" | "revert";
  revertedTo: number | null;
  at: string;
  byName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  /** Short list of what changed ("checks", "schedule", …). */
  changed: string[];
}

function changedFields(before: Record<string, unknown> | null, after: Record<string, unknown>): string[] {
  const flat = (o: Record<string, unknown> | null) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o ?? {})) {
      if (k === "settings" && v && typeof v === "object") for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) out[k2] = JSON.stringify(v2);
      else out[k] = JSON.stringify(v);
    }
    return out;
  };
  const a = flat(before);
  const b = flat(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
}

async function versions(ctx: ServiceContext, scopeKey: string, limit = 30): Promise<SettingsVersion[]> {
  const rows = await ctx.db
    .select({ log: aiRoleSettingsLog, byName: users.shortName })
    .from(aiRoleSettingsLog)
    .leftJoin(users, eq(users.id, aiRoleSettingsLog.changedBy))
    .where(eq(aiRoleSettingsLog.scopeKey, scopeKey))
    .orderBy(desc(aiRoleSettingsLog.version))
    .limit(limit);
  return rows.map(({ log, byName }) => ({
    version: log.version,
    action: log.action as SettingsVersion["action"],
    revertedTo: log.revertedTo,
    at: log.createdAt.toISOString(),
    byName: byName ?? null,
    before: log.before ?? null,
    after: log.after,
    changed: changedFields(log.before ?? null, log.after),
  }));
}

/** A role's settings history, newest first. */
export async function listRoleVersions(ctx: ServiceContext, key: string): Promise<SettingsVersion[]> {
  assertAiRolesAccess(ctx);
  await roleOrThrow(ctx, key);
  return versions(ctx, `role:${key}`);
}

/** A hire's settings history, newest first. */
export async function listHireVersions(ctx: ServiceContext, hireId: unknown): Promise<SettingsVersion[]> {
  assertAiRolesAccess(ctx);
  assertValidId(hireId, "AI role");
  const [hire] = await ctx.db.select({ id: aiRoleHires.id, companyId: aiRoleHires.companyId }).from(aiRoleHires).where(eq(aiRoleHires.id, hireId));
  if (!hire) throw new ServiceError("not_found", "AI role not found");
  await assertCompanyAccess(ctx, hire.companyId);
  return versions(ctx, `hire:${hire.id}`);
}

async function roleOrThrow(ctx: ServiceContext, key: unknown): Promise<ResolvedRole> {
  if (typeof key !== "string" || key.length > 80) throw new ServiceError("not_found", "Role not found");
  const role = await resolveRole(ctx.db, key);
  if (!role) throw new ServiceError("not_found", "Role not found");
  // A custom role belongs to its company: it follows the company rule.
  if (role.companyId) await assertCompanyAccess(ctx, role.companyId);
  return role;
}

/** Company metric definitions by key (for the watched-numbers checks). */
async function companyMetrics(db: Db, companyId: string) {
  return db
    .select({ key: metricDefinitions.key, name: metricDefinitions.name, aliases: metricDefinitions.aliases, isPayData: metricDefinitions.isPayData })
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.companyId, companyId), isNull(metricDefinitions.archivedAt)));
}

function invalid(message: string, field: string): never {
  throw new ServiceError("validation", message, { [field]: [message] });
}

/**
 * Validates role-level settings for this role. Custom roles: the numbers it watches must be
 * of its company and never pay data (salary guard); what it waits for and its ratio checks
 * only use watched numbers. Built-in roles have no watched numbers of their own.
 */
async function validateRoleConfig(ctx: ServiceContext, role: { engine: ResolvedRole["engine"]; custom: boolean; companyId: string | null }, raw: unknown): Promise<RoleConfig> {
  const parsed = roleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ServiceError("validation", issue ? `${issue.path.join(".") || "settings"}: ${issue.message}` : "Invalid settings");
  }
  const c = parsed.data;
  const out: RoleConfig = {};
  const profile = cleanProfile(c.profile);
  if (role.custom && !profile?.name) invalid("Give the role a name", "name");
  if (profile) out.profile = profile;
  if (c.schedule) out.schedule = c.schedule;
  if (c.recipients) {
    const founders = new Set((await listFounders(ctx.db)).map((f) => f.id));
    if (c.recipients.some((id) => !founders.has(id))) invalid("An AI role only reports to the founders", "recipients");
    if (c.recipients.length) out.recipients = [...new Set(c.recipients)];
  }
  if (c.checks) {
    try {
      out.checks = normalizeChecks(role.engine, c.checks);
    } catch (err) {
      if (err instanceof ChecksError) invalid(err.message, "checks");
      throw err;
    }
  }
  if (!role.custom) {
    if (c.watchedMetricKeys || c.requiredMetricKeys || c.ratioChecks) invalid("Only a custom role chooses the numbers it watches", "watchedMetricKeys");
    return out;
  }
  const defs = await companyMetrics(ctx.db, role.companyId!);
  const watched = [...new Set(c.watchedMetricKeys ?? [])];
  if (!watched.length) invalid("Choose at least one number it watches", "watchedMetricKeys");
  for (const k of watched) {
    const matching = defs.filter((d) => d.key === k);
    if (!matching.length) invalid(`Not a number of this company: ${k}`, "watchedMetricKeys");
    // Salary guard: a custom role never watches pay data (salaries, payroll, wages, ФОТ…).
    if (matching.some((d) => isSalaryMetric(d))) invalid(`${matching[0]!.name} is pay data — a custom role can never watch salaries`, "watchedMetricKeys");
  }
  out.watchedMetricKeys = watched;
  const required = [...new Set(c.requiredMetricKeys ?? watched)];
  const notWatched = required.filter((k) => !watched.includes(k));
  if (notWatched.length) invalid(`It can only wait for numbers it watches (${notWatched.join(", ")})`, "requiredMetricKeys");
  out.requiredMetricKeys = required;
  const ratios = c.ratioChecks ?? [];
  for (const r of ratios) {
    if (!watched.includes(r.numeratorKey) || !watched.includes(r.denominatorKey)) invalid("A ratio check uses two numbers the role watches", "ratioChecks");
  }
  if (new Set(ratios.map((r) => r.id)).size !== ratios.length) invalid("Two ratio checks have the same id", "ratioChecks");
  out.ratioChecks = ratios;
  return out;
}

/** The role's identity as stored in ai_role_templates (custom roles need a row there for hires). */
async function syncCustomTemplateRow(db: Db, key: string, config: RoleConfig, now: Date): Promise<void> {
  const values = {
    key,
    name: config.profile?.name ?? "Custom role",
    description: config.profile?.description ?? "",
    status: "available" as const,
    responsibilities: config.profile?.responsibilities ?? [],
    requiredData: { byCompanyType: {}, optionalUploads: [] },
    defaultSchedule: config.schedule ?? { kind: "monthly" as const, day: 10 },
    reportSections: ["Risks", "Warnings", "Info", "Numbers used", "AI summary (after the AI provider is chosen)"],
    sort: 1000,
  };
  const { key: _k, ...rest } = values;
  void _k;
  await db.insert(aiRoleTemplates).values(values).onConflictDoUpdate({ target: aiRoleTemplates.key, set: { ...rest, updatedAt: now } });
}

/**
 * Saves a role's settings (the whole role-level config) as a new version. Hires of the role
 * that did not override a setting follow it at once (their reports say "Settings changed"
 * where the analysis changes); open runs are re-checked.
 */
export async function updateRoleConfig(ctx: ServiceContext, key: unknown, input: unknown, opts: { revertedTo?: number } = {}): Promise<ResolvedRole> {
  assertAiRolesAccess(ctx);
  const role = await roleOrThrow(ctx, key);
  const config = await validateRoleConfig(ctx, role, input);
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    if (!role.custom) {
      await tx.insert(aiRoleConfigs).values({ key: role.key, kind: "builtin", config: {}, version: 0, createdBy: ctx.user.id, createdAt: ctx.now, updatedAt: ctx.now }).onConflictDoNothing();
    }
    const [row] = await tx.select().from(aiRoleConfigs).where(eq(aiRoleConfigs.key, role.key)).for("update");
    const before = (row?.config ?? {}) as Record<string, unknown>;
    if (JSON.stringify(before) === JSON.stringify(config)) return;
    const version = await logSettingsChange(tx, {
      scope: "role",
      roleKey: role.key,
      action: opts.revertedTo ? "revert" : "edit",
      revertedTo: opts.revertedTo,
      before,
      after: config as Record<string, unknown>,
      userId: ctx.user.id,
      now: ctx.now,
    });
    await tx.update(aiRoleConfigs).set({ config: config as Record<string, unknown>, version, updatedBy: ctx.user.id, updatedAt: ctx.now }).where(eq(aiRoleConfigs.key, role.key));
    if (role.custom) await syncCustomTemplateRow(tx, role.key, config, ctx.now);
  });
  const hires = await ctx.db.select({ id: aiRoleHires.id }).from(aiRoleHires).where(and(eq(aiRoleHires.templateKey, role.key), eq(aiRoleHires.status, "active")));
  for (const h of hires) await recheckOpenRuns(ctx.db, h.id, ctx.now, today(ctx));
  return (await resolveRole(ctx.db, role.key))!;
}

/**
 * A custom role: from scratch or a copy of a built-in role (its name, job description,
 * responsibilities, instructions, schedule and generic checks; the numbers it needs for this
 * company's type become the watched numbers — pay data excluded). Founders only.
 */
export async function createCustomRole(ctx: ServiceContext, input: CustomRoleCreateInput): Promise<ResolvedRole> {
  assertAiRolesAccess(ctx);
  const parsed = customRoleCreateSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ServiceError("validation", issue ? `${issue.path.join(".") || "role"}: ${issue.message}` : "Invalid role");
  }
  const data = parsed.data;
  await assertCompanyAccess(ctx, data.companyId);
  const [company] = await ctx.db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, data.companyId));
  let config: RoleConfig = { ...data.config };
  let basedOn: string | null = null;
  if (data.copyFrom) {
    const source = await resolveRole(ctx.db, data.copyFrom);
    if (!source || source.custom || templateEngine(templateByKey(source.key)) !== "finance") {
      throw new ServiceError("validation", "Only a role that analyses numbers can be copied");
    }
    basedOn = source.key;
    const defs = await companyMetrics(ctx.db, data.companyId);
    const watchable = new Set(defs.filter((d) => !isSalaryMetric(d)).map((d) => d.key));
    const copiedKeys = requiredKeysFor(source, companyTypeFor(company!.slug)).filter((k) => watchable.has(k));
    config = {
      profile: {
        name: data.config.profile?.name ?? `${source.name} (copy)`,
        description: data.config.profile?.description ?? source.description,
        responsibilities: data.config.profile?.responsibilities ?? source.responsibilities,
        ...(data.config.profile?.instructions ?? source.instructions ? { instructions: data.config.profile?.instructions ?? source.instructions ?? undefined } : {}),
      },
      schedule: data.config.schedule ?? source.defaultSchedule,
      ...(data.config.recipients ?? source.config.recipients ? { recipients: data.config.recipients ?? source.config.recipients } : {}),
      checks: data.config.checks ?? genericChecksOf(source.checks),
      watchedMetricKeys: data.config.watchedMetricKeys ?? copiedKeys,
      ...(data.config.requiredMetricKeys ? { requiredMetricKeys: data.config.requiredMetricKeys } : {}),
      ...(data.config.ratioChecks ? { ratioChecks: data.config.ratioChecks } : {}),
    };
  }
  const config2 = await validateRoleConfig(ctx, { engine: "custom", custom: true, companyId: data.companyId }, config);
  const key = `${CUSTOM_PREFIX}${randomBytes(5).toString("hex")}`;
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.insert(aiRoleConfigs).values({
      key,
      kind: "custom",
      companyId: data.companyId,
      basedOn,
      config: config2 as Record<string, unknown>,
      version: 1,
      createdBy: ctx.user.id,
      updatedBy: ctx.user.id,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
    await syncCustomTemplateRow(tx, key, config2, ctx.now);
    await logSettingsChange(tx, { scope: "role", roleKey: key, action: "create", before: null, after: config2 as Record<string, unknown>, userId: ctx.user.id, now: ctx.now });
  });
  return (await resolveRole(ctx.db, key))!;
}

/** The generic checks (custom catalogue) a copy takes over from a built-in role's checks. */
function genericChecksOf(checks: ChecksConfig): ChecksConfig {
  const out: ChecksConfig = {};
  for (const c of CHECK_CATALOGUE.custom) if (checks[c.id]) out[c.id] = { ...checks[c.id]! };
  return out;
}

/** Restores a role's settings to an earlier version (logged as a new version). */
export async function revertRole(ctx: ServiceContext, key: unknown, version: number): Promise<ResolvedRole> {
  assertAiRolesAccess(ctx);
  const role = await roleOrThrow(ctx, key);
  const [row] = await ctx.db
    .select()
    .from(aiRoleSettingsLog)
    .where(and(eq(aiRoleSettingsLog.scopeKey, `role:${role.key}`), eq(aiRoleSettingsLog.version, Number(version))));
  if (!row) throw new ServiceError("not_found", "Version not found");
  return updateRoleConfig(ctx, role.key, row.after, { revertedTo: row.version });
}

/** Restores a hire's settings and notes to an earlier version (logged as a new version). */
export async function revertHire(ctx: ServiceContext, hireId: unknown, version: number): Promise<HireView> {
  assertAiRolesAccess(ctx);
  assertValidId(hireId, "AI role");
  const [row] = await ctx.db
    .select()
    .from(aiRoleSettingsLog)
    .where(and(eq(aiRoleSettingsLog.scopeKey, `hire:${hireId}`), eq(aiRoleSettingsLog.version, Number(version))));
  if (!row) throw new ServiceError("not_found", "Version not found");
  const after = row.after as { settings?: HireSettings; notes?: string | null };
  const settings = { ...(after.settings ?? {}) } as Record<string, unknown>;
  // Overrides that version did not have are cleared (back to the role's).
  for (const k of ["checks", "profile"]) if (!(k in settings)) settings[k] = null;
  return updateHire(ctx, hireId, { settings: settings as never, notes: after.notes ?? null }, { revertedTo: row.version });
}

/** Custom roles' hires (for the custom roles list): key → hire ids. */
export async function customRoleHires(ctx: ServiceContext, keys: string[]): Promise<Map<string, string[]>> {
  assertAiRolesAccess(ctx);
  const out = new Map<string, string[]>();
  const custom = keys.filter(isCustomKey);
  if (!custom.length) return out;
  const rows = await ctx.db.select({ id: aiRoleHires.id, key: aiRoleHires.templateKey }).from(aiRoleHires).where(inArray(aiRoleHires.templateKey, custom)).orderBy(asc(aiRoleHires.createdAt));
  for (const r of rows) out.set(r.key, [...(out.get(r.key) ?? []), r.id]);
  return out;
}
