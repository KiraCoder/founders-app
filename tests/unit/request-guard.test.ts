import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { SESSION_COOKIE, signSessionToken } from "@/server/auth/session-token";
import { checkMutatingApiRequest } from "@/server/http/request-guard";

const URL_ = "https://cockpit.example.com/api/v1/tasks";
const json = { "content-type": "application/json" };

function req(method: string, headers: Record<string, string> = {}, url = URL_) {
  return new Request(url, { method, headers, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
}

describe("checkMutatingApiRequest (CSRF guard)", () => {
  it("lets reads through untouched", () => {
    expect(checkMutatingApiRequest(req("GET", { origin: "https://evil.example" }))).toEqual({ ok: true });
  });

  it("allows same-origin JSON writes, APP_URL and no-Origin API clients", () => {
    expect(checkMutatingApiRequest(req("POST", { ...json, origin: "https://cockpit.example.com" }))).toEqual({ ok: true });
    expect(
      checkMutatingApiRequest(req("PATCH", { "content-type": "application/json; charset=utf-8", origin: "https://cockpit.example.com" })),
    ).toEqual({ ok: true });
    expect(checkMutatingApiRequest(req("DELETE", { origin: "https://cockpit.example.com" }))).toEqual({ ok: true });
    expect(
      checkMutatingApiRequest(req("POST", { ...json, origin: "https://app.example.org" }), { APP_URL: "https://app.example.org/" }),
    ).toEqual({ ok: true });
    // Behind a proxy: Host / X-Forwarded-Host decide what "this site" is.
    expect(
      checkMutatingApiRequest(
        req("POST", { ...json, origin: "https://public.example.net", "x-forwarded-host": "public.example.net", "x-forwarded-proto": "https" }, "http://10.0.0.5:3000/api/v1/tasks"),
      ),
    ).toEqual({ ok: true });
    // curl / mobile client: no Origin, no Sec-Fetch-Site.
    expect(checkMutatingApiRequest(req("POST", json))).toEqual({ ok: true });
    expect(checkMutatingApiRequest(req("POST", { ...json, "sec-fetch-site": "same-origin" }))).toEqual({ ok: true });
  });

  it("blocks cross-site writes", () => {
    for (const origin of ["https://evil.example", "null", "http://cockpit.example.com", "https://cockpit.example.com.evil.example", "garbage"]) {
      const r = checkMutatingApiRequest(req("POST", { ...json, origin }));
      expect(r, origin).toMatchObject({ ok: false, status: 403 });
    }
    expect(checkMutatingApiRequest(req("DELETE", { origin: "https://evil.example" }))).toMatchObject({ status: 403 });
    expect(checkMutatingApiRequest(req("PATCH", { ...json, "sec-fetch-site": "cross-site" }))).toMatchObject({ status: 403 });
    expect(checkMutatingApiRequest(req("POST", { ...json, "sec-fetch-site": "same-site" }))).toMatchObject({ status: 403 });
  });

  it("requires application/json for writes with a body", () => {
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const headers: Record<string, string> = { origin: "https://cockpit.example.com" };
      if (type) headers["content-type"] = type;
      expect(checkMutatingApiRequest(req("POST", headers)), String(type)).toMatchObject({ ok: false, status: 415 });
    }
  });
});

describe("middleware", () => {
  const base = "http://localhost:3000";
  const cookie = async () => {
    const token = await signSessionToken(
      { sid: "test-session", uid: "11111111-1111-4111-8111-111111111111" },
      new Date(Date.now() + 60_000),
    );
    return `${SESSION_COOKIE}=${token}`;
  };

  it("API without a session: JSON 401", async () => {
    const res = await middleware(new NextRequest(`${base}/api/v1/tasks`));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("pages without a session: redirect to /login with next", async () => {
    const res = await middleware(new NextRequest(`${base}/tasks?view=my`));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/tasks?view=my");
    const home = await middleware(new NextRequest(`${base}/`));
    expect(new URL(home.headers.get("location")!).search).toBe("");
  });

  it("only the login page and the two secret-checked endpoints are public", async () => {
    const pass = (r: Response) => r.headers.get("x-middleware-next") === "1";
    for (const p of ["/login", "/api/telegram/webhook", "/api/cron/tick"]) {
      expect(pass(await middleware(new NextRequest(`${base}${p}`, { method: "POST" })))).toBe(true);
    }
    // Look-alike paths are not public.
    for (const p of ["/api/telegram/webhookx", "/api/cron/ticks", "/api/telegram", "/api/cron"]) {
      const res = await middleware(new NextRequest(`${base}${p}`, { method: "POST" }));
      expect(res.status).toBe(401);
    }
    const page = await middleware(new NextRequest(`${base}/loginx`));
    expect(page.status).toBe(307);
    expect(pass(await middleware(new NextRequest(`${base}/dev/notifications`)))).toBe(false);
  });

  it("public paths and tampered cookies", async () => {
    expect((await middleware(new NextRequest(`${base}/login`))).headers.get("x-middleware-next")).toBe("1");
    const bad = await middleware(new NextRequest(`${base}/api/v1/tasks`, { headers: { cookie: `${SESSION_COOKIE}=nope` } }));
    expect(bad.status).toBe(401);
  });

  it("signed-in: same-origin JSON writes pass, cross-site writes are 403, form posts 415", async () => {
    const c = await cookie();
    const ok = await middleware(
      new NextRequest(`${base}/api/v1/tasks`, { method: "POST", headers: { cookie: c, origin: base, ...json }, body: "{}" }),
    );
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    const evil = await middleware(
      new NextRequest(`${base}/api/v1/tasks`, { method: "POST", headers: { cookie: c, origin: "https://evil.example", ...json }, body: "{}" }),
    );
    expect(evil.status).toBe(403);
    const form = await middleware(
      new NextRequest(`${base}/api/v1/tasks/x`, {
        method: "PATCH",
        headers: { cookie: c, origin: base, "content-type": "application/x-www-form-urlencoded" },
        body: "a=b",
      }),
    );
    expect(form.status).toBe(415);
  });
});

describe("multipart uploads (holding documents)", () => {
  const UP = "https://cockpit.example.com/api/v1/holding/files";
  const mp = { "content-type": "multipart/form-data; boundary=x" };

  it("allowed only on the upload path, only with proof of same-site", () => {
    expect(checkMutatingApiRequest(req("POST", { ...mp, origin: "https://cockpit.example.com" }, UP))).toEqual({ ok: true });
    expect(checkMutatingApiRequest(req("POST", { ...mp, "sec-fetch-site": "same-origin" }, UP))).toEqual({ ok: true });
    // A cross-site form, or a request with neither header, is refused.
    expect(checkMutatingApiRequest(req("POST", { ...mp, origin: "https://evil.example" }, UP))).toMatchObject({ ok: false, status: 403 });
    expect(checkMutatingApiRequest(req("POST", mp, UP))).toMatchObject({ ok: false, status: 403 });
    expect(checkMutatingApiRequest(req("POST", { ...mp, "sec-fetch-site": "cross-site" }, UP))).toMatchObject({ ok: false, status: 403 });
    // Other endpoints still need JSON.
    expect(checkMutatingApiRequest(req("POST", { ...mp, origin: "https://cockpit.example.com" }, "https://cockpit.example.com/api/v1/holding/acts"))).toMatchObject({
      ok: false,
      status: 415,
    });
    expect(checkMutatingApiRequest(req("PATCH", { ...mp, origin: "https://cockpit.example.com" }, UP))).toMatchObject({ ok: false, status: 415 });
  });
});
