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

/** Converts Zod errors into ServiceError("validation"); passes ServiceErrors through. */
export function toServiceError(err: unknown): ServiceError | null {
  if (err instanceof ServiceError) return err;
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
