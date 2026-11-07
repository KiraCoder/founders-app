import type { Tone } from "@/components/ui";

/** A routine's status as a tag (server and client components). */
export const STATUS_TONE: Record<string, Tone> = { active: "ok", paused: "warn", ended: "neutral", archived: "neutral" };
export const STATUS_LABEL: Record<string, string> = { active: "Active", paused: "Paused", ended: "Ended", archived: "Archived" };
