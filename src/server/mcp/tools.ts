import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolsFor } from "./all-tools";
import { runNow, toolErrorMessage, type ToolEnv } from "./registry";

export type { ToolEnv } from "./registry";

/**
 * The Founder Cockpit MCP server (Claude connector). The tools themselves live in the shared
 * registry (./registry.ts, ./all-tools.ts), also used by the in-app AI assistant; here each tool
 * marked for the "mcp" surface is registered and run in one step (Claude asks the user itself).
 */

export const SERVER_INSTRUCTIONS = [
  "Founder Cockpit is the task and project tracker of the Asqa Zou group founders (Nuraaly and Talant).",
  "Use create_project to save a plan: one project in a company with its tasks; each task can be assigned to a founder or to a person who works at that company, and the Cockpit then chases the assignees (Telegram reminders).",
  "Companies, projects and assignees are given by name; when a name is ambiguous or unknown the tool answers with the candidates — ask the user which one is meant, then call again with the full name.",
  "Dates are YYYY-MM-DD in the group's timezone. Tasks are shared with the other founder unless private is true (a personal todo, which can only be assigned to the founder themself).",
].join(" ");

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function buildCockpitServer(env: ToolEnv): McpServer {
  const server = new McpServer({ name: "founder-cockpit", title: "Founder Cockpit", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  for (const tool of toolsFor("mcp")) {
    const annotations =
      tool.kind === "read"
        ? ({ readOnlyHint: true, openWorldHint: false } as const)
        : { readOnlyHint: false, destructiveHint: false, openWorldHint: false, ...(tool.idempotent ? { idempotentHint: true } : {}) };
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations }, async (args: unknown): Promise<CallToolResult> => {
      try {
        const out = await runNow(tool, env, args);
        return { content: [{ type: "text", text: `${out.summary}\n\n${JSON.stringify(out.data, null, 2)}` }] };
      } catch (err) {
        return failure(toolErrorMessage(err, "mcp"));
      }
    });
  }
  return server;
}
