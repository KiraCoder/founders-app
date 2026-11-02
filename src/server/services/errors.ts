import { ZodError } from "zod";

export type ServiceErrorCode = "unauthorized" | "forbidden" | "not_found" | "validation" | "conflict";

const STATUS: Record<ServiceErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation: 400,
  conflict: 409,
};

/** Expected, user-facing failure from the service layer. */
export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
    public readonly fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
  get status(): number {
    return STATUS[this.code];
  }
}

/** Postgres error code of an error or of its cause (drivers / Drizzle wrap them). */
function pgCode(err: unknown): string | null {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/**
 * Converts Zod errors into ServiceError("validation"); passes ServiceErrors through.
 * A deadlock (40P01) or serialization failure (40001) between two saves at the same
 * moment becomes a "conflict" with a retry hint (nothing of that save was written).
 */
export function toServiceError(err: unknown): ServiceError | null {
  if (err instanceof ServiceError) return err;
  const code = pgCode(err);
  if (code === "40P01" || code === "40001") {
    return new ServiceError("conflict", "Someone else saved at the same moment, so nothing was saved. Please try again.");
  }
  if (err instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".") || "_";
      (fields[key] ??= []).push(issue.message);
    }
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return new ServiceError("validation", `${where}${first?.message ?? "Invalid input"}`, fields);
  }
  return null;
}
