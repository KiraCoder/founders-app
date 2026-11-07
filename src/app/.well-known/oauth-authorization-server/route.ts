import { authorizationServerMetadataResponse, preflight } from "@/server/http/oauth";

export const dynamic = "force-dynamic";

/** RFC 8414 authorization server metadata for the Claude connector. Public. */
export function GET(req: Request) {
  return authorizationServerMetadataResponse(req);
}

export function OPTIONS() {
  return preflight();
}
