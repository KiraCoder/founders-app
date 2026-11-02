import type { NextRequest } from "next/server";
import { handleApi } from "@/server/api";
import { readHoldingFile } from "@/server/services/holding-files";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/holding/files/:id — the document, only for a signed-in founder (401 / 403 /
 * 404 otherwise). Served with its checked type, `nosniff`, a sandbox CSP and no caching.
 * `?download=1` downloads instead of opening in the browser.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    const { file, bytes } = await readHoldingFile(ctx, id);
    const download = new URL(req.url).searchParams.get("download") === "1";
    const ascii = file.name.replace(/[^\x20-\x7e]/g, "_");
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-length": String(bytes.byteLength),
        "content-disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; object-src 'self'",
        "cache-control": "private, no-store",
      },
    });
  });
}
