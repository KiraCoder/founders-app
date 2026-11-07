import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { parseMetricInput } from "@/lib/metrics";
import type { Db } from "@/server/db/connect";
import {
  companies,
  companyUnits,
  connectorRuns,
  extensionIngestLog,
  extensionKeys,
  ingestRateCounters,
  metricDefinitions,
  users,
  type ConnectorRunConflict,
} from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/types";
import { accessibleCompaniesWhere, assertExtensionAccess, assertValidId } from "./access";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { DEBT_METRIC_KEY } from "./holding";
import { byMetricThenPeriod, resolvePeriod, writeMetricValueTx } from "./metrics";

/**
 * The browser extension's ingest API (POST /api/v1/ingest, see src/server/http/ingest.ts):
 * founders create personal keys in Settings (shown once, stored as SHA-256), the extension
 * sends numbers it read from web pages, and each point goes through the same write path as
 * every other number (writeMetricValueTx, C4 rules) with source `extension`:
 * exact decimals, no future / unfinished periods, only companies the key's owner can access,
 * never replacing a number a founder typed or uploaded (a different number is a conflict,
 * recorded so the card shows "Source disagrees"), latest wins among automatic values.
 */

export const KEY_PREFIX = "fcx_";
export const INGEST_MAX_POINTS = 500;
export const INGEST_MAX_BYTES = 256 * 1024;
/** Requests per key per minute (fixed one-minute windows, counted before processing). */
export const INGEST_RATE_LIMIT = 60;
const LOG_REJECTED_MAX = 50;

export const hashKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

export interface ExtensionKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const keyNameSchema = z.object({ name: z.string().trim().min(1, "Give the key a name (e.g. “Laptop Chrome”)").max(60) }).strict();

function keyView(k: typeof extensionKeys.$inferSelect): ExtensionKeyView {
  return {
    id: k.id,
    name: k.name,
    prefix: k.keyPrefix,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  };
}

/** The signed-in founder's own keys (newest first; revoked ones too, marked). */
export async function listExtensionKeys(ctx: ServiceContext): Promise<ExtensionKeyView[]> {
  assertExtensionAccess(ctx);
  const rows = await ctx.db.select().from(extensionKeys).where(eq(extensionKeys.userId, ctx.user.id)).orderBy(desc(extensionKeys.createdAt));
  return rows.map(keyView);
}

/** A new personal key. The key itself is returned ONCE; only its SHA-256 is stored. */
export async function createExtensionKey(ctx: ServiceContext, input: unknown): Promise<{ key: string; view: ExtensionKeyView }> {
  assertExtensionAccess(ctx);
  const { name } = keyNameSchema.parse(input);
  const live = await ctx.db
    .select({ n: count() })
    .from(extensionKeys)
    .where(and(eq(extensionKeys.userId, ctx.user.id), isNull(extensionKeys.revokedAt)));
  if ((live[0]?.n ?? 0) >= 10) throw new ServiceError("validation", "At most 10 active keys — revoke one first");
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const [row] = await ctx.db
    .insert(extensionKeys)
    .values({ userId: ctx.user.id, name, keyHash: hashKey(key), keyPrefix: key.slice(0, KEY_PREFIX.length + 4), createdAt: ctx.now })
    .returning();
  return { key, view: keyView(row!) };
}

/** Revokes one of the founder's own keys (another founder's key is "not found"). */
export async function revokeExtensionKey(ctx: ServiceContext, id: unknown): Promise<ExtensionKeyView> {
  assertExtensionAccess(ctx);
  assertValidId(id, "Key");
  const [row] = await ctx.db
    .update(extensionKeys)
    .set({ revokedAt: ctx.now })
    .where(and(eq(extensionKeys.id, id), eq(extensionKeys.userId, ctx.user.id), isNull(extensionKeys.revokedAt)))
    .returning();
  if (row) return keyView(row);
  const [existing] = await ctx.db.select().from(extensionKeys).where(and(eq(extensionKeys.id, id), eq(extensionKeys.userId, ctx.user.id)));
  if (!existing) throw new ServiceError("not_found", "Key not found");
  return keyView(existing);
}

export interface IngestLogView {
  id: string;
  at: string;
  keyName: string;
  ownerName: string | null;
  adapterId: string | null;
  status: string;
  points: number;
  accepted: number;
  rejected: number;
  conflicts: number;
  firstReasons: string[];
}

/** Recent ingest calls of every founder's keys (company numbers are shared between the founders). */
export async function listIngestLog(ctx: ServiceContext, limit = 20): Promise<IngestLogView[]> {
  assertExtensionAccess(ctx);
  const rows = await ctx.db
    .select({ log: extensionIngestLog, keyName: extensionKeys.name, ownerName: users.shortName })
    .from(extensionIngestLog)
    .leftJoin(extensionKeys, eq(extensionKeys.id, extensionIngestLog.keyId))
    .leftJoin(users, eq(users.id, extensionKeys.userId))
    .orderBy(desc(extensionIngestLog.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(({ log, keyName, ownerName }) => ({
    id: log.id,
    at: log.createdAt.toISOString(),
    keyName: keyName ?? "Deleted key",
    ownerName: ownerName ?? null,
    adapterId: log.adapterId,
    status: log.status,
    points: log.points,
    accepted: log.accepted,
    rejected: log.rejected,
    conflicts: log.conflicts,
    firstReasons: [...new Set((log.details?.rejected ?? []).map((r) => r.reason))].slice(0, 3),
  }));
}

// ---------------------------------------------------------------------------
// Authentication, rate limit, log (used by the route; no session)
// ---------------------------------------------------------------------------

export interface KeyAuth {
  keyId: string;
  user: SessionUser;
}

/** The only shape a key header can have: "Bearer fcx_" + 43 base64url characters (32 bytes). */
const KEY_HEADER = /^Bearer\s+(fcx_[A-Za-z0-9_-]{43})\s*$/i;

/** Cheap pre-check, no database: could this header carry a key at all? */
export function wellFormedKeyHeader(authorization: string | null): boolean {
  return KEY_HEADER.test(authorization ?? "");
}

/** "Bearer fcx_…" → the key and its owner (a founder), or null (missing, malformed, unknown, revoked). */
export async function authenticateKey(db: Db, authorization: string | null): Promise<KeyAuth | null> {
  const m = KEY_HEADER.exec(authorization ?? "");
  if (!m) return null;
  const [row] = await db
    .select({ keyId: extensionKeys.id, id: users.id, email: users.email, name: users.name, shortName: users.shortName, role: users.role })
    .from(extensionKeys)
    .innerJoin(users, eq(users.id, extensionKeys.userId))
    .where(and(eq(extensionKeys.keyHash, hashKey(m[1]!)), isNull(extensionKeys.revokedAt)));
  // A key acts as its owner, who must still be a founder.
  if (!row || row.role !== "founder") return null;
  return { keyId: row.keyId, user: { id: row.id, email: row.email, name: row.name, shortName: row.shortName, role: row.role } };
}

/** Start of the fixed one-minute window `now` falls in. */
function windowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

/**
 * Counts one hit in `bucket`'s current one-minute window, atomically
 * (INSERT … ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n), and returns the new count and
 * the seconds until the window ends. Parallel requests each get their own number, so no more
 * than the limit can ever pass. A new window also deletes windows older than an hour.
 */
export async function hitRateCounter(db: Db, bucket: string, now: Date): Promise<{ n: number; retryAfter: number }> {
  const start = windowStart(now);
  const [row] = await db
    .insert(ingestRateCounters)
    .values({ bucket, windowStart: start, n: 1 })
    .onConflictDoUpdate({ target: [ingestRateCounters.bucket, ingestRateCounters.windowStart], set: { n: sql`${ingestRateCounters.n} + 1` } })
    .returning({ n: ingestRateCounters.n });
  const n = Number(row?.n ?? 1);
  if (n === 1) await db.delete(ingestRateCounters).where(lt(ingestRateCounters.windowStart, new Date(start.getTime() - 3_600_000)));
  return { n, retryAfter: Math.max(1, Math.ceil((start.getTime() + 60_000 - now.getTime()) / 1000)) };
}

/** Failed authentications (well-formed header, unknown / revoked key) per IP per minute. */
export const INGEST_AUTH_FAIL_LIMIT = 20;

/**
 * Before looking a key up: has this IP already failed authentication INGEST_AUTH_FAIL_LIMIT
 * times this minute? (One primary-key read; the lookup is skipped while it is blocked.)
 */
export async function authFailuresExceeded(db: Db, ip: string, now: Date): Promise<{ blocked: boolean; retryAfter: number }> {
  const start = windowStart(now);
  const [row] = await db
    .select({ n: ingestRateCounters.n })
    .from(ingestRateCounters)
    .where(and(eq(ingestRateCounters.bucket, `authfail:${ip}`), eq(ingestRateCounters.windowStart, start)));
  return { blocked: (row?.n ?? 0) >= INGEST_AUTH_FAIL_LIMIT, retryAfter: Math.max(1, Math.ceil((start.getTime() + 60_000 - now.getTime()) / 1000)) };
}

/** Counts one failed authentication for the IP. */
export async function recordAuthFailure(db: Db, ip: string, now: Date): Promise<void> {
  await hitRateCounter(db, `authfail:${ip}`, now);
}

/**
 * Takes one of the key's INGEST_RATE_LIMIT requests of this minute BEFORE the request is
 * processed (refused, failed and rate-limited calls count too). `limited` when none is left.
 */
export async function takeIngestSlot(db: Db, keyId: string, now: Date): Promise<{ limited: boolean; retryAfter: number }> {
  const { n, retryAfter } = await hitRateCounter(db, `key:${keyId}`, now);
  return { limited: n > INGEST_RATE_LIMIT, retryAfter };
}

export async function logIngest(
  db: Db,
  auth: KeyAuth,
  e: { adapterId: string | null; status: "ok" | "invalid"; points: number; accepted: number; rejected: { index: number; reason: string }[]; conflicts: number; message?: string },
  now: Date,
): Promise<void> {
  await db.insert(extensionIngestLog).values({
    keyId: auth.keyId,
    userId: auth.user.id,
    adapterId: e.adapterId,
    status: e.status,
    points: e.points,
    accepted: e.accepted,
    rejected: e.rejected.length,
    conflicts: e.conflicts,
    details: { ...(e.message ? { message: e.message.slice(0, 300) } : {}), rejected: e.rejected.slice(0, LOG_REJECTED_MAX) },
    createdAt: now,
  });
  await db.update(extensionKeys).set({ lastUsedAt: now }).where(eq(extensionKeys.id, auth.keyId));
}

// ---------------------------------------------------------------------------
// The ingest itself
// ---------------------------------------------------------------------------

export const ingestEnvelopeSchema = z
  .object({
    source: z.literal("extension"),
    adapterId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/, "adapterId: letters, digits, . _ : - (at most 64)"),
    points: z.array(z.unknown()).max(INGEST_MAX_POINTS, `At most ${INGEST_MAX_POINTS} points per request`),
  })
  .strict();

const pointSchema = z
  .object({
    companySlug: z.string().trim().min(1).max(80),
    metricKey: z.string().trim().min(1).max(80),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD"),
    value: z.string({ error: "value must be a string, e.g. \"1234.5\"" }).max(40),
    /** Factory / unit of a number tracked per unit (e.g. Alura Style "hbk"). */
    unitSlug: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export interface IngestResult {
  accepted: number;
  rejected: { index: number; reason: string }[];
  conflicts: number;
}

interface Accepted {
  index: number;
  metricId: string;
  companyId: string;
  period: string;
  value: number;
}

/**
 * Validates and writes the points as the key's owner (`ctx`). Each point is accepted or
 * rejected on its own, with a reason; accepted points are written in one transaction, one
 * connector-like run per company (`extension:<adapterId>`) recording conflicts.
 */
export async function ingestPoints(ctx: ServiceContext, adapterId: string, points: readonly unknown[]): Promise<IngestResult> {
  assertExtensionAccess(ctx);
  const rejected: { index: number; reason: string }[] = [];
  const reject = (index: number, reason: string) => rejected.push({ index, reason });
  const todayIso = today(ctx);

  const parsed: { index: number; p: z.output<typeof pointSchema> }[] = [];
  points.forEach((raw, index) => {
    const r = pointSchema.safeParse(raw);
    if (!r.success) {
      const issue = r.error.issues[0]!;
      const field = issue.path.join(".");
      reject(index, issue.code === "unrecognized_keys" ? `Unknown field: ${issue.keys.join(", ")}` : `${field ? `${field}: ` : ""}${issue.message}`);
    } else parsed.push({ index, p: r.data });
  });

  // Companies the key's owner can access (others are "unknown": isolation, no existence leak).
  const slugs = [...new Set(parsed.map((x) => x.p.companySlug))];
  const companyRows = slugs.length
    ? await ctx.db
        .select({ id: companies.id, slug: companies.slug, name: companies.name })
        .from(companies)
        .where(and(inArray(companies.slug, slugs), isNull(companies.archivedAt), accessibleCompaniesWhere(ctx)))
    : [];
  const bySlug = new Map(companyRows.map((c) => [c.slug, c]));
  const defs = companyRows.length
    ? await ctx.db
        .select({ d: metricDefinitions, unitSlug: companyUnits.slug })
        .from(metricDefinitions)
        .leftJoin(companyUnits, eq(companyUnits.id, metricDefinitions.companyUnitId))
        .where(and(inArray(metricDefinitions.companyId, companyRows.map((c) => c.id)), isNull(metricDefinitions.archivedAt)))
        .orderBy(asc(metricDefinitions.sort))
    : [];

  const accepted: Accepted[] = [];
  for (const { index, p } of parsed) {
    const company = bySlug.get(p.companySlug);
    if (!company) {
      reject(index, `Unknown company: ${p.companySlug}`);
      continue;
    }
    let matching = defs.filter((x) => x.d.companyId === company.id && x.d.key === p.metricKey);
    if (p.unitSlug) matching = matching.filter((x) => x.unitSlug === p.unitSlug);
    if (!matching.length) {
      reject(index, `Unknown number for ${company.name}: ${p.metricKey}${p.unitSlug ? ` (${p.unitSlug})` : ""}`);
      continue;
    }
    if (matching.length > 1) {
      reject(index, `${p.metricKey} is tracked per factory (${matching.map((x) => x.unitSlug ?? "whole company").join(", ")}) — add unitSlug`);
      continue;
    }
    const def = matching[0]!.d;
    if (def.key === DEBT_METRIC_KEY || def.sourceKind === "derived") {
      reject(index, `${def.name} is computed from the Holding акты — not accepted from the extension`);
      continue;
    }
    let period: string;
    try {
      period = resolvePeriod(p.periodStart, def.granularity, todayIso);
    } catch (err) {
      reject(index, err instanceof ServiceError ? err.message : "Period not recognised");
      continue;
    }
    if (period !== p.periodStart) {
      reject(index, `periodStart must be the first day of its ${def.granularity === "week" ? "week (Monday)" : def.granularity}: ${period}`);
      continue;
    }
    const v = parseMetricInput(p.value, def.unit);
    if ("error" in v) {
      reject(index, v.error);
      continue;
    }
    accepted.push({ index, metricId: def.id, companyId: company.id, period, value: v.value });
  }

  // Two points for the same number and period in one request: all of them are refused.
  const groups = new Map<string, Accepted[]>();
  for (const a of accepted) groups.set(`${a.metricId}|${a.period}`, [...(groups.get(`${a.metricId}|${a.period}`) ?? []), a]);
  const toWrite: Accepted[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) toWrite.push(list[0]!);
    else for (const a of list) reject(a.index, `Points ${list.map((x) => x.index).join(", ")} are the same number and period — send one`);
  }

  let conflicts = 0;
  if (toWrite.length) {
    const sourceId = `extension:${adapterId}`;
    await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const companiesHit = [...new Set(toWrite.map((a) => a.companyId))];
      for (const companyId of companiesHit) {
        const mine = toWrite.filter((a) => a.companyId === companyId).sort(byMetricThenPeriod);
        const periods = mine.map((a) => a.period).sort();
        const [run] = await tx
          .insert(connectorRuns)
          .values({
            connectorId: sourceId,
            companyId,
            status: "running",
            rangeFrom: periods[0]!,
            rangeTo: periods.at(-1)!,
            pointsReceived: mine.length,
            triggeredBy: ctx.user.id,
            startedAt: ctx.now,
          })
          .returning({ id: connectorRuns.id });
        const runConflicts: ConnectorRunConflict[] = [];
        const agreed: { metricId: string; period: string }[] = [];
        let written = 0;
        for (const a of mine) {
          const res = await writeMetricValueTx(tx, a.metricId, a.period, a.value, { source: "extension", enteredBy: ctx.user.id, connectorRunId: run!.id, now: ctx.now });
          if (res.action === "conflict") {
            conflicts++;
            const keptSource = res.previousSource === "upload" ? "upload" : "manual";
            runConflicts.push({ metricId: a.metricId, period: a.period, kept: res.previous!, keptSource, reported: a.value });
            reject(a.index, `A founder ${keptSource === "upload" ? "uploaded" : "entered"} ${res.previous} for this period — kept (recorded as “source disagrees”)`);
            continue;
          }
          if (res.action === "created" || res.action === "updated") written++;
          else if (res.previousSource === "manual" || res.previousSource === "upload") agreed.push({ metricId: a.metricId, period: a.period });
        }
        // A call that changed nothing and said nothing about a founder's number leaves no run.
        if (written === 0 && runConflicts.length === 0 && agreed.length === 0) {
          await tx.delete(connectorRuns).where(eq(connectorRuns.id, run!.id));
          continue;
        }
        await tx
          .update(connectorRuns)
          .set({
            status: "ok",
            valuesWritten: written,
            message: `Browser extension (${adapterId})`,
            details: runConflicts.length || agreed.length ? { ...(runConflicts.length ? { conflicts: runConflicts } : {}), ...(agreed.length ? { agreed } : {}) } : null,
            finishedAt: ctx.now,
          })
          .where(eq(connectorRuns.id, run!.id));
      }
    });
  }
  rejected.sort((a, b) => a.index - b.index);
  return { accepted: points.length - rejected.length, rejected, conflicts };
}
