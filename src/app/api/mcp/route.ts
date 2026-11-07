import { getDb } from "@/server/db/client";
import { handleMcpPreflight, handleMcpRequest } from "@/server/http/mcp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * /api/mcp — Founder Cockpit remote MCP server for Claude (Streamable HTTP, stateless).
 * OAuth bearer token required (README, "Connect to Claude"); exempt from the session middleware.
 */
export async function POST(req: Request) {
  return handleMcpRequest(req, { db: await getDb() });
}

export async function GET(req: Request) {
  return handleMcpRequest(req, { db: await getDb() });
}

export async function DELETE(req: Request) {
  return handleMcpRequest(req, { db: await getDb() });
}

export function OPTIONS() {
  return handleMcpPreflight();
}
