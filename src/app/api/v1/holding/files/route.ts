import { NextResponse, type NextRequest } from "next/server";
import { handleApi, jsonError } from "@/server/api";
import { HoldingFileError, MAX_HOLDING_FILE_BYTES, saveHoldingFile } from "@/server/services/holding-files";
import { fileUploadStatus } from "@/server/storage/file-storage";

export const dynamic = "force-dynamic";

/** Multipart overhead allowed on top of the file itself (boundaries, headers, the name). */
const OVERHEAD = 64 * 1024;
/** Same message for every "too big" case (declared length, streamed body, the file itself). */
const TOO_LARGE = "The file is larger than 10 MB — scan it at a lower resolution or split it, then upload again";

/** Reads the body but stops as soon as it is larger than `max` bytes (never buffers more). */
async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * POST /api/v1/holding/files — multipart/form-data with one `file` (PDF, JPG or PNG, max
 * 10 MB). Returns `{ data: { id, name, contentType, sizeBytes } }`; attach it to a contract
 * or акт with its id. Founders only; same-site only (see request-guard.ts).
 */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    // No storage that keeps files here (production without a working remote adapter, e.g.
    // Vercel's read-only disk): say so before reading the body.
    const uploads = fileUploadStatus();
    if (!uploads.available) return jsonError(503, "unavailable", uploads.message!);
    const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "multipart/form-data") return jsonError(415, "unsupported_media_type", "Send the file as multipart/form-data");
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_HOLDING_FILE_BYTES + OVERHEAD) return jsonError(413, "too_large", TOO_LARGE);
    const body = await readLimited(req, MAX_HOLDING_FILE_BYTES + OVERHEAD);
    if (!body) return jsonError(413, "too_large", TOO_LARGE);
    let form: FormData;
    try {
      form = await new Response(body as BodyInit, { headers: { "content-type": req.headers.get("content-type")! } }).formData();
    } catch {
      return jsonError(400, "validation", "Could not read the upload");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return jsonError(400, "validation", "Choose a file", { file: ["Choose a file"] });
    if (file.size > MAX_HOLDING_FILE_BYTES) return jsonError(413, "too_large", TOO_LARGE);
    try {
      const saved = await saveHoldingFile(ctx, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      return NextResponse.json({ data: saved }, { status: 201 });
    } catch (err) {
      if (err instanceof HoldingFileError) return jsonError(err.httpStatus, err.httpStatus === 415 ? "unsupported_media_type" : err.httpStatus === 413 ? "too_large" : err.httpStatus === 503 ? "unavailable" : "validation", err.message, err.fields);
      throw err;
    }
  });
}
