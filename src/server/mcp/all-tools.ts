import "server-only";
import { ROUTINE_TOOLS } from "@/server/assistant/routine-tools";
import { COCKPIT_TOOLS, type AnyTool, type ToolSurface } from "./registry";

/** Every tool of the shared registry (connector + assistant). */
export const ALL_TOOLS: readonly AnyTool[] = [...COCKPIT_TOOLS, ...ROUTINE_TOOLS];

/** The tools offered on one surface ("mcp" = the Claude connector, "assistant" = the in-app chat). */
export function toolsFor(surface: ToolSurface): AnyTool[] {
  return ALL_TOOLS.filter((t) => t.surfaces.includes(surface));
}

export function findTool(name: string, surface: ToolSurface): AnyTool | undefined {
  return toolsFor(surface).find((t) => t.name === name);
}
