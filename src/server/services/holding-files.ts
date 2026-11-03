import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { holdingFiles, intercompanyActs, intercompanyContracts } from "@/server/db/schema";
import { fileStorage, fileStorageByName, fileUploadStatus, UPLOADS_UNAVAILABLE_MESSAGE } from "@/server/storage/file-storage";
import { assertHoldingAccess, assertValidId } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import type { FileRef } from "./holding";

/**
 * Documents attached to contracts and акты: PDF, JPG or PNG, at most 10 MB. The type is
 * decided by the file's first bytes (its "magic number"), never by its name or the
 * browser's claim, so a renamed .exe or .html is refused. Served back only to founders
 * (route /api/v1/holding/files/:id) with the stored type and `nosniff`.
 */
export const MAX_HOLDING_FILE_BYTES = 10 * 1024 * 1024;

export type AllowedType = "application/pdf" | "image/jpeg" | "image/png";
const EXT: Record<AllowedType, "pdf" | "jpg" | "png"> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

export function detectFileType(bytes: Uint8Array): AllowedType | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

/** Keeps a readable name without paths, control characters or quotes (used in Content-Disposition). */
export function cleanFileName(name: string, type: AllowedType): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "")
    .trim()
    .slice(0, 120);
  return base || `document.${EXT[type]}`;
}

export class HoldingFileError extends ServiceError {
  constructor(
    message: string,
    public readonly httpStatus: 413 | 415 | 400 | 503,
  ) {
    super("validation", message, { file: [message] });
  }
}

export async function saveHoldingFile(ctx: ServiceContext, input: { name: string; bytes: Uint8Array }): Promise<FileRef> {
  assertHoldingAccess(ctx);
  const uploads = fileUploadStatus();
  if (!uploads.available) throw new HoldingFileError(uploads.message ?? UPLOADS_UNAVAILABLE_MESSAGE, 503);
  if (input.bytes.byteLength === 0) throw new HoldingFileError("The file is empty", 400);
  if (input.bytes.byteLength > MAX_HOLDING_FILE_BYTES) throw new HoldingFileError("The file is larger than 10 MB", 413);
  const type = detectFileType(input.bytes);
  if (!type) throw new HoldingFileError("Only PDF, JPG or PNG files can be attached", 415);
  const storage = fileStorage();
  const id = randomUUID();
  const storageKey = `holding/${id}.${EXT[type]}`;
  const name = cleanFileName(input.name, type);
  // Metadata first, bytes second: a failed insert leaves no file behind, and a failed
  // write removes the row again — no orphan either way. (A row whose bytes are still being
  // written reads as "not found" for that moment; nothing links to it yet.)
  await ctx.db.insert(holdingFiles).values({
    id,
    storage: storage.name,
    storageKey,
    originalName: name,
    contentType: type,
    sizeBytes: input.bytes.byteLength,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    uploadedBy: ctx.user.id,
    createdAt: ctx.now,
  });
  try {
    await storage.put(storageKey, input.bytes, type);
  } catch (err) {
    await ctx.db.delete(holdingFiles).where(eq(holdingFiles.id, id)).catch(() => undefined);
    await storage.delete(storageKey).catch(() => undefined);
    throw err;
  }
  return { id, name, contentType: type, sizeBytes: input.bytes.byteLength };
}

export async function readHoldingFile(ctx: ServiceContext, id: string): Promise<{ file: FileRef; bytes: Uint8Array }> {
  assertHoldingAccess(ctx);
  assertValidId(id, "File");
  const [row] = await ctx.db.select().from(holdingFiles).where(and(eq(holdingFiles.id, id), isNull(holdingFiles.archivedAt)));
  if (!row) throw new ServiceError("not_found", "File not found");
  const bytes = await fileStorageByName(row.storage).get(row.storageKey);
  if (!bytes) throw new ServiceError("not_found", "File not found");
  return { file: { id: row.id, name: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes }, bytes };
}

/** Uploads not attached to anything after this long are removed. */
export const UNATTACHED_FILE_TTL_MS = 24 * 60 * 60 * 1000;
/** At most this many per tick (the tick runs every few minutes; a backlog drains over time). */
export const CLEANUP_BATCH = 20;

/**
 * Removes uploads that were never attached to an акт or a contract (the founder uploaded
 * and then closed the panel) once they are 24 h old. Called from the scheduler tick,
 * bounded to CLEANUP_BATCH files. Only files never attached (attached_at null) and still
 * referenced by nothing are removed; a document that was attached once is never deleted,
 * even if it was replaced later. The row is deleted first (atomically re-checking that
 * nothing points at it), then the bytes.
 */
export async function cleanupUnattachedFiles(db: Db, now: Date): Promise<{ removed: number }> {
  const cutoff = new Date(now.getTime() - UNATTACHED_FILE_TTL_MS);
  const candidates = await db
    .select({ id: holdingFiles.id })
    .from(holdingFiles)
    .where(and(isNull(holdingFiles.attachedAt), lt(holdingFiles.createdAt, cutoff)))
    .orderBy(asc(holdingFiles.createdAt))
    .limit(CLEANUP_BATCH);
  let removed = 0;
  for (const c of candidates) {
    const rows = await db
      .delete(holdingFiles)
      .where(
        and(
          eq(holdingFiles.id, c.id),
          isNull(holdingFiles.attachedAt),
          sql`not exists (select 1 from ${intercompanyActs} where ${intercompanyActs.attachmentFileId} = ${holdingFiles.id})`,
          sql`not exists (select 1 from ${intercompanyContracts} where ${intercompanyContracts.attachmentFileId} = ${holdingFiles.id})`,
        ),
      )
      .returning({ storage: holdingFiles.storage, storageKey: holdingFiles.storageKey });
    const row = rows[0];
    if (!row) continue;
    removed++;
    await fileStorageByName(row.storage)
      .delete(row.storageKey)
      .catch((err: unknown) => console.error("[holding] could not delete unattached file bytes", err));
  }
  return { removed };
}
