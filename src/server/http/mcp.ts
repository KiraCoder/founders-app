import "server-only";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Db } from "@/server/db/connect";
import { buildCockpitServer } from "@/server/mcp/tools";
import { makeContext } from "@/server/services/context";
import { authenticateAccessToken, oauthBaseUrl, OAUTH_SCOPE, protectedResourceMetadataUrl } from "@/server/services/oauth";

/**
 * /api/mcp — the Founder Cockpit remote MCP server (Streamable HTTP, stateless, JSON responses).
 *
 * Every request needs `Authorization: Bearer <access token>` from the connector's OAuth flow
 * (services/oauth.ts). Without one (or with an expired / revoked one) → 401 with
 * `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`, which is
 * how claude.ai discovers the authorization server. A valid token runs a fresh MCP server whose
 * tools act as the founder who authorized it. No session cookie is read; the path is exempt from
 * the session middleware (exact path only). GET (a server-sent event stream) is not offered in
 * stateless mode → 405 after auth.
 */

export interface McpDeps {
  db: Db;
  now?: () => Date;
  timeZone?: string;
  env?: Record<string, string | undefined>;
}

export const MCP_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "600",
};

/** Upper bound on a request body (a big create_project is a few KB). */
const MAX_BODY = 512 * 1024;

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(MCP_CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function unauthorized(req: Request, env: McpDeps["env"], invalid: boolean): Response {
  const base = oauthBaseUrl(req, env);
  const parts = [`Bearer resource_metadata="${protectedResourceMetadataUrl(base)}"`, `scope="${OAUTH_SCOPE}"`];
  if (invalid) parts.push('error="invalid_token"', 'error_description="The access token is missing, expired or revoked"');
  return new Response(JSON.stringify({ error: invalid ? "invalid_token" : "unauthorized", error_description: "Connect Founder Cockpit in Claude (OAuth) first" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "WWW-Authenticate": parts.join(", "), ...MCP_CORS },
  });
}

export function handleMcpPreflight(): Response {
  return new Response(null, { status: 204, headers: MCP_CORS });
}

export async function handleMcpRequest(req: Request, deps: McpDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const auth = await authenticateAccessToken(deps.db, req.headers.get("authorization"), now);
  if (!auth.ok) return unauthorized(req, deps.env, auth.reason === "invalid");

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST, OPTIONS", ...MCP_CORS },
    });
  }
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) {
    return withCors(new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null }), { status: 413 }));
  }

  const base = makeContext(deps.db, auth.user, now);
  const ctx = deps.timeZone ? { ...base, timeZone: deps.timeZone } : base;
  const server = buildCockpitServer({ ctx, baseUrl: oauthBaseUrl(req, deps.env) });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY,
  });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    return withCors(res);
  } finally {
    // JSON mode: the response is complete once handleRequest resolves.
    await server.close().catch(() => undefined);
  }
}
