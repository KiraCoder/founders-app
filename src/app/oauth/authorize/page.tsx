import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { checkAuthorizeRequest, consentToken, oauthBaseUrl, redirectWith } from "@/server/services/oauth";

export const metadata: Metadata = { title: "Connect an app" };
export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-[440px]">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-[10px] bg-accent text-[18px] font-bold text-accent-ink">F</span>
          <div>
            <p className="eyebrow">Asqa Zou group</p>
            <h1 className="text-[20px] font-semibold">Founder Cockpit</h1>
          </div>
        </div>
        <div className="card-raised p-6">{children}</div>
      </div>
    </main>
  );
}

/**
 * OAuth consent screen for the Claude connector (services/oauth.ts). The founder must be signed
 * in (the middleware sends everyone else to /login and back here). Allow / Cancel post to
 * /api/oauth/authorize with a consent token bound to this founder and this request.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = oauthBaseUrl(new Request(`${proto}://${host}/oauth/authorize`));

  const user = await getCurrentUser();
  if (!user) {
    const qs = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (v === undefined ? [] : [[k, one(v) ?? ""]]))).toString();
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
  }

  const params = {
    response_type: one(sp.response_type),
    client_id: one(sp.client_id),
    redirect_uri: one(sp.redirect_uri),
    code_challenge: one(sp.code_challenge),
    code_challenge_method: one(sp.code_challenge_method),
    state: one(sp.state),
    scope: one(sp.scope),
    resource: one(sp.resource),
  };
  const check = await checkAuthorizeRequest(await getDb(), params, base);
  if (!check.ok && check.kind === "redirect") {
    redirect(redirectWith(check.redirectUri, { error: check.error, error_description: check.description, state: check.state, iss: base }));
  }
  if (!check.ok) {
    return (
      <Shell>
        <h2 className="mb-2 text-[16px] font-semibold">This connection link is not valid</h2>
        <p className="text-[13px] text-muted">{check.message}</p>
      </Shell>
    );
  }
  if (user.role !== "founder") {
    return (
      <Shell>
        <h2 className="mb-2 text-[16px] font-semibold">Only the founders can connect apps</h2>
        <p className="text-[13px] text-muted">Ask Nuraaly or Talant to connect Founder Cockpit to Claude.</p>
      </Shell>
    );
  }

  const r = check.request;
  const token = consentToken(user.id, { clientId: r.client.clientId, redirectUri: r.redirectUri, codeChallenge: r.codeChallenge }, new Date());
  const returnHost = new URL(r.redirectUri).host;
  return (
    <Shell>
      <p className="eyebrow mb-2">Connect an app</p>
      <h2 className="mb-3 text-[17px] font-semibold">
        Allow {r.client.name} to read and create projects and tasks in Founder Cockpit?
      </h2>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-[13px]">
        <li>It acts as you ({user.shortName}): it sees what you see — companies, people, projects, shared tasks and your own personal todos.</li>
        <li>It can create projects and tasks, assign them to founders or staff, update and complete tasks and add comments.</li>
        <li>It cannot see salaries, the holding or numbers, and cannot delete anything.</li>
        <li>You can disconnect it any time in Settings → Connected apps.</li>
      </ul>
      <p className="mb-4 text-[12px] text-muted">You will be sent back to {returnHost}.</p>
      <form method="post" action="/api/oauth/authorize" className="flex gap-2">
        <input type="hidden" name="response_type" value="code" />
        <input type="hidden" name="client_id" value={r.client.clientId} />
        <input type="hidden" name="redirect_uri" value={r.redirectUri} />
        <input type="hidden" name="code_challenge" value={r.codeChallenge} />
        <input type="hidden" name="code_challenge_method" value="S256" />
        <input type="hidden" name="scope" value={r.scope} />
        {r.state !== null && <input type="hidden" name="state" value={r.state} />}
        {r.resource && <input type="hidden" name="resource" value={r.resource} />}
        <input type="hidden" name="consent_token" value={token} />
        <button type="submit" name="decision" value="allow" className="btn btn-primary flex-1">
          Allow
        </button>
        <button type="submit" name="decision" value="deny" className="btn flex-1">
          Cancel
        </button>
      </form>
    </Shell>
  );
}
