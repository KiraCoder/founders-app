import "server-only";
import { NextResponse } from "next/server";
import { getApiContext } from "@/server/context";
import type { ServiceContext } from "@/server/services/context";
import { toServiceError } from "@/server/services/errors";

export function jsonError(status: number, code: string, message: string, fields?: Record<string, string[]>) {
  return NextResponse.json({ error: { code, message, ...(fields ? { fields } : {}) } }, { status });
}

/**
 * Wraps a REST handler: session-cookie auth, JSON errors, ServiceError -> HTTP status.
 * Kept thin on purpose: all rules live in the service layer.
 */
export async function handleApi(fn: (ctx: ServiceContext) => Promise<Response>): Promise<Response> {
  const ctx = await getApiContext();
  if (!ctx) return jsonError(401, "unauthorized", "Sign in required");
  try {
    return await fn(ctx);
  } catch (err) {
    const se = toServiceError(err);
    if (se) return jsonError(se.status, se.code, se.message, se.fields);
    console.error("[api] unexpected error", err);
    return jsonError(500, "internal", "Unexpected error");
  }
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return Symbol.for("invalid-json");
  }
}

export function isInvalidJson(v: unknown): boolean {
  return v === Symbol.for("invalid-json");
}
