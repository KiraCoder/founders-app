import { timingSafeEqual, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { isLoginRateLimited } from "@/server/auth/login-limiter";
import { getDb } from "@/server/db/client";
import { loginAttempts, users } from "@/server/db/schema";
import { agentPanelHires } from "@/server/services/ai-roles";
import { listCompanies } from "@/server/services/companies";
import { makeContext } from "@/server/services/context";
import { companyFreshness } from "@/server/services/metrics";
import { getTaskFormOptions } from "@/server/services/options";
import { getTodaySummary } from "@/server/services/tasks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Step-by-step timing of what login + the Today page do, to find where a request hangs.
 * Protected by CRON_SECRET (?key=...). Returns step names and timings only: no data.
 * The one write test is rolled back.
 */
function keyOk(given: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

class Rollback extends Error {}

export async function GET(request: Request) {
  if (!keyOk(new URL(request.url).searchParams.get("key"))) {
    return Response.json({ ok: false, error: "Add ?key=<CRON_SECRET> to the address." }, { status: 401 });
  }
  const steps: { step: string; ms: number; ok: boolean; error?: string }[] = [];
  const run = async <T,>(step: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const t = Date.now();
    try {
      const v = await Promise.race([
        fn(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no answer within 8 s")), 8_000)),
      ]);
      steps.push({ step, ms: Date.now() - t, ok: true });
      return v;
    } catch (err) {
      if (err instanceof Rollback) {
        steps.push({ step, ms: Date.now() - t, ok: true });
        return undefined;
      }
      const e = err as { code?: string; message?: string };
      const msg = `${e?.code ? e.code + ": " : ""}${String(e?.message ?? err)}`.replace(/postgres(ql)?:\/\/\S+/gi, "[url]");
      steps.push({ step, ms: Date.now() - t, ok: false, error: msg.slice(0, 200) });
      return undefined;
    }
  };

  const db = await run("connect", () => getDb());
  if (!db) return Response.json({ ok: false, region: process.env.VERCEL_REGION ?? null, steps });

  await run("select 1", () => db.execute(sql`select 1`));
  await run("login: rate-limit check", () => isLoginRateLimited(db, { email: "nuraaly@founders.local", ip: null }));
  const rows = await run("login: find founder", () =>
    db.select().from(users).where(eq(users.email, "nuraaly@founders.local")).limit(1),
  );
  const founder = rows?.[0];
  steps.push({ step: `founder exists: ${founder ? "yes" : "NO"}`, ms: 0, ok: Boolean(founder) });
  await run("login: password hash check", () => bcrypt.compare("not-the-password", founder?.passwordHash ?? "$2a$10$abcdefghijklmnopqrstuuJ7nq1lU0V9mXl3eH3Z1q9iV8D3g5r2m"));
  await run("write test (rolled back)", () =>
    db.transaction(async (tx) => {
      await tx.insert(loginAttempts).values({ emailHash: "health-check", ipHash: "health-check" });
      throw new Rollback();
    }),
  );

  if (founder) {
    const ctx = makeContext(db, {
      id: founder.id,
      email: founder.email,
      name: founder.name,
      shortName: founder.shortName,
      role: "founder",
    });
    await run("layout: companies", () => listCompanies(ctx));
    await run("layout: agent panel", () => agentPanelHires(ctx));
    await run("today: summary", () => getTodaySummary(ctx));
    await run("today: task form options", () => getTaskFormOptions(ctx));
    await run("today: company freshness", () => companyFreshness(ctx));
    await run("today: all three in parallel", () =>
      Promise.all([getTodaySummary(ctx), getTaskFormOptions(ctx), companyFreshness(ctx)]),
    );
  }
  return Response.json(
    { ok: steps.every((s) => s.ok), region: process.env.VERCEL_REGION ?? null, steps },
    { headers: { "cache-control": "no-store" } },
  );
}
