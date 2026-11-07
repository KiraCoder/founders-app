import { preflight, protectedResourceMetadataResponse } from "@/server/http/oauth";

export const dynamic = "force-dynamic";

/**
 * RFC 9728 protected resource metadata for /api/mcp. Served at the root well-known path (what the
 * 401's WWW-Authenticate points to) and at the path-inserted form
 * /.well-known/oauth-protected-resource/api/mcp; any other suffix is 404.
 */
export async function GET(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  if (path.length > 0 && path.join("/") !== "api/mcp") return new Response("Not found", { status: 404 });
  return protectedResourceMetadataResponse(req);
}

export function OPTIONS() {
  return preflight();
}
