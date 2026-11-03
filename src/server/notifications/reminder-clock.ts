import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { resolveAppBaseUrl, type AppUrlSource } from "@/server/app-url";
import type { Db } from "@/server/db/connect";

/**
 * Settings → "Start reminder clock" (founders only). Vercel Hobby runs its own cron only once
 * a day, too rare for reminders, so the database calls the app instead: Supabase's pg_cron
 * runs a job every 10 minutes that POSTs to {APP_URL}/api/cron/tick through pg_net with
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * - The tick URL and CRON_SECRET are stored in Supabase Vault (encrypted). The job's SQL
 *   only names the Vault entries, so neither value is in cron.job's plain text.
 * - Idempotent: pressing it again updates both Vault entries and reschedules the same job.
 * - Uses the app's own database connection (DATABASE_URL). Where pg_cron / pg_net / Vault
 *   are missing (the local embedded database, a plain Postgres) it says so and changes
 *   nothing; README → "Reminder clock" has the manual SQL and the cron-job.org option.
 */

export const REMINDER_JOB_NAME = "founders-tick";
export const REMINDER_SCHEDULE = "*/10 * * * *";
export const VAULT_TICK_URL = "founders_tick_url";
export const VAULT_CRON_SECRET = "founders_cron_secret";
/** pg_net gives up after 5 s by default; the tick route may run up to 60 s (maxDuration). */
export const TICK_TIMEOUT_MS = 60_000;
export const TICK_PATH = "/api/cron/tick";

type Env = Record<string, string | undefined>;

/** The SQL the cron job runs. Reads the URL and the secret from Vault at run time. */
export function buildTickJobCommand(): string {
  const fromVault = (name: string) => `(select decrypted_secret from vault.decrypted_secrets where name = '${name}' limit 1)`;
  return [
    "select net.http_post(",
    `  url := ${fromVault(VAULT_TICK_URL)},`,
    `  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || ${fromVault(VAULT_CRON_SECRET)}),`,
    "  body := '{}'::jsonb,",
    `  timeout_milliseconds := ${TICK_TIMEOUT_MS}`,
    ");",
  ].join("\n");
}

/** Vault entry by name (Supabase Vault: vault.secrets, values encrypted at rest). */
export function buildVaultLookup(name: string): SQL {
  return sql`select id::text as id from vault.secrets where name = ${name} limit 1`;
}

/** New Vault entry. The value travels as a bind parameter, never inside the SQL text. */
export function buildVaultCreate(name: string, value: string, description: string): SQL {
  return sql`select vault.create_secret(${value}, ${name}, ${description})::text as id`;
}

/** Replaces an existing Vault entry's value (same bind-parameter rule). */
export function buildVaultUpdate(id: string, value: string): SQL {
  return sql`select 1 as ok from (select vault.update_secret(${id}::uuid, ${value})) as updated`;
}

/** cron.schedule with an existing job name replaces that job (pg_cron ≥ 1.3; Supabase has it). */
export function buildSchedule(): SQL {
  return sql`select cron.schedule(${REMINDER_JOB_NAME}, ${REMINDER_SCHEDULE}, ${buildTickJobCommand()}) as jobid`;
}

export interface ReminderClockConfig {
  missing: string[];
  tickUrl: string | null;
  appUrlSource: AppUrlSource | null;
}

export function reminderClockConfig(env: Env = process.env): ReminderClockConfig {
  const base = resolveAppBaseUrl(env);
  const missing: string[] = [];
  if (!base) missing.push("APP_URL");
  if (!env.CRON_SECRET?.trim()) missing.push("CRON_SECRET");
  return { missing, tickUrl: base ? `${base.url}${TICK_PATH}` : null, appUrlSource: base?.source ?? null };
}

export interface ReminderRun {
  status: string;
  message: string | null;
  startedAt: string | null;
}
export interface ReminderResponse {
  statusCode: number | null;
  error: string | null;
  at: string | null;
}
export interface ReminderClockStatus {
  /** pg_cron, pg_net and Vault are all there. */
  available: boolean;
  /** What is missing on this database (when not available). */
  unavailable: string[];
  jobExists: boolean;
  schedule: string | null;
  active: boolean | null;
  /** Last 5 runs (cron.job_run_details): did the job's SQL run. */
  runs: ReminderRun[];
  /** Last 5 HTTP answers pg_net got (net._http_response), when readable. */
  responses: ReminderResponse[];
}

export type ReminderClockResult =
  | { ok: false; step: "config"; config: ReminderClockConfig; message: string }
  | { ok: false; step: "unavailable"; config: ReminderClockConfig; message: string; status: ReminderClockStatus }
  | { ok: false; step: "failed"; config: ReminderClockConfig; message: string }
  | { ok: true; config: ReminderClockConfig; message: string; status: ReminderClockStatus };

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

async function query<T>(db: Db, q: SQL): Promise<T[]> {
  return rowsOf<T>(await db.execute(q));
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null);

async function schemaExists(db: Db, name: string): Promise<boolean> {
  const [row] = await query<{ ok: boolean }>(db, sql`select exists (select 1 from pg_namespace where nspname = ${name}) as ok`);
  return row?.ok === true;
}

/**
 * Makes sure pg_cron, pg_net and Vault exist (creating the extensions when allowed). Returns
 * what is still missing and, for each, the database's own reason (deploy review #4: e.g.
 * "permission denied to create extension" is not the same as "not installed"), scrubbed of
 * secrets.
 */
async function ensureExtensions(db: Db, secrets: string[]): Promise<{ missing: string[]; reasons: string[] }> {
  const missing: string[] = [];
  const reasons: string[] = [];
  const steps: { schema: string; label: string; create: SQL }[] = [
    { schema: "cron", label: "pg_cron", create: sql`create extension if not exists pg_cron` },
    { schema: "net", label: "pg_net", create: sql`create extension if not exists pg_net` },
    { schema: "vault", label: "Vault (supabase_vault)", create: sql`create extension if not exists supabase_vault` },
  ];
  for (const s of steps) {
    if (await schemaExists(db, s.schema)) continue;
    let reason: string | null = null;
    try {
      await db.execute(s.create);
    } catch (err) {
      // Not installed on this server (e.g. the local embedded database) or not allowed.
      reason = errMessage(err, secrets);
    }
    if (!(await schemaExists(db, s.schema))) {
      missing.push(s.label);
      if (reason) reasons.push(`${s.label}: ${reason}`);
    }
  }
  return { missing, reasons };
}

async function readStatus(db: Db, unavailable: string[]): Promise<ReminderClockStatus> {
  const base: ReminderClockStatus = { available: unavailable.length === 0, unavailable, jobExists: false, schedule: null, active: null, runs: [], responses: [] };
  if (!(await schemaExists(db, "cron"))) return base;
  const [job] = await query<{ jobid: number | string; schedule: string; active: boolean }>(
    db,
    sql`select jobid, schedule, active from cron.job where jobname = ${REMINDER_JOB_NAME} order by jobid desc limit 1`,
  );
  if (!job) return base;
  const runs = await query<{ status: string; return_message: string | null; start_time: unknown }>(
    db,
    sql`select status, return_message, start_time from cron.job_run_details where jobid = ${job.jobid} order by start_time desc nulls last limit 5`,
  ).catch(() => []);
  let responses: ReminderResponse[] = [];
  if (await schemaExists(db, "net")) {
    responses = (
      await query<{ status_code: number | null; error_msg: string | null; created: unknown }>(
        db,
        sql`select status_code, error_msg, created from net._http_response order by created desc limit 5`,
      ).catch(() => [])
    ).map((r) => ({ statusCode: r.status_code, error: r.error_msg, at: iso(r.created) }));
  }
  return {
    ...base,
    jobExists: true,
    schedule: job.schedule,
    active: job.active,
    runs: runs.map((r) => ({ status: r.status, message: r.return_message, startedAt: iso(r.start_time) })),
    responses,
  };
}

const UNAVAILABLE_HINT =
  "This database has no {what}. The local embedded database never has them; on Supabase they are built in. " +
  "Alternatives: the manual SQL or a free cron-job.org job (README → Scheduler (cron)).";

async function upsertVaultSecret(db: Db, name: string, value: string, description: string): Promise<void> {
  const [existing] = await query<{ id: string }>(db, buildVaultLookup(name));
  if (existing) await db.execute(buildVaultUpdate(existing.id, value));
  else await db.execute(buildVaultCreate(name, value, description));
}

/** Status only (no changes). Never creates extensions. */
export async function reminderClockStatus(db: Db, env: Env = process.env): Promise<ReminderClockResult> {
  const config = reminderClockConfig(env);
  try {
    const unavailable: string[] = [];
    for (const [schema, label] of [["cron", "pg_cron"], ["net", "pg_net"], ["vault", "Vault (supabase_vault)"]] as const) {
      if (!(await schemaExists(db, schema))) unavailable.push(label);
    }
    const status = await readStatus(db, unavailable);
    if (!status.jobExists && unavailable.length) {
      return { ok: false, step: "unavailable", config, status, message: UNAVAILABLE_HINT.replace("{what}", unavailable.join(", ")) };
    }
    return { ok: true, config, status, message: status.jobExists ? "The reminder clock is running." : "Not started yet." };
  } catch (err) {
    return { ok: false, step: "failed", config, message: `Could not read the status: ${errMessage(err)}` };
  }
}

/** Enables the extensions, stores URL + secret in Vault, (re)schedules the job. */
export async function startReminderClock(db: Db, env: Env = process.env): Promise<ReminderClockResult> {
  const config = reminderClockConfig(env);
  if (config.missing.length) {
    return { ok: false, step: "config", config, message: `Missing in Vercel → Settings → Environment Variables: ${config.missing.join(", ")}. Add them, redeploy, then press Start again.` };
  }
  const secret = env.CRON_SECRET!.trim();
  try {
    const { missing: unavailable, reasons } = await ensureExtensions(db, [secret]);
    if (unavailable.length) {
      const status = await readStatus(db, unavailable);
      const why = reasons.length ? ` The database said — ${reasons.join("; ")}` : "";
      return { ok: false, step: "unavailable", config, status, message: UNAVAILABLE_HINT.replace("{what}", unavailable.join(", ")) + why };
    }
    await upsertVaultSecret(db, VAULT_TICK_URL, config.tickUrl!, "Founders App: reminder clock tick URL");
    await upsertVaultSecret(db, VAULT_CRON_SECRET, secret, "Founders App: CRON_SECRET for the reminder clock");
    await db.execute(buildSchedule());
    const status = await readStatus(db, []);
    return {
      ok: true,
      config,
      status,
      message: `Started: every 10 minutes the database calls ${config.tickUrl}. The first runs show below within 10 minutes (press Check status).`,
    };
  } catch (err) {
    return { ok: false, step: "failed", config, message: `Could not start the reminder clock: ${errMessage(err, [secret])}` };
  }
}

/**
 * A short error for the page. Drizzle's query errors append the bind parameters (which hold
 * the secret) to the message, so the driver's own message (the cause) is used and any secret
 * value is masked anyway.
 */
export function errMessage(err: unknown, secrets: string[] = []): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
  let m = cause ? cause.message : err instanceof Error ? err.message : String(err);
  m = m.split(/\nparams:/)[0]!;
  for (const s of secrets) if (s) m = m.split(s).join("***");
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}
