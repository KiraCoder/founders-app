import type { NextRequest } from "next/server";
import { handleApi } from "@/server/api";
import { readHoldingFile } from "@/server/services/holding-files";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/holding/files/:id — the document, only for a signed-in founder (401 / 403 /
 * 404 otherwise). Served with its checked type, `nosniff` and no caching; images also with a sandbox CSP (PDFs not: see below).
 * `?download=1` downloads instead of opening in the browser.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    const { file, bytes } = await readHoldingFile(ctx, id);
    const download = new URL(req.url).searchParams.get("download") === "1";
    const ascii = file.name.replace(/[^\x20-\x7e]/g, "_");
    const headers: Record<string, string> = {
      "content-type": file.contentType,
      "content-length": String(bytes.byteLength),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    };
    // Images keep the sandbox CSP: a browser never runs anything from them anyway, and
    // the CSP is a second lock. PDFs do NOT get it: Chrome's built-in PDF viewer is an
    // extension that refuses to render inside a sandboxed document (blank page / forced
    // download), and founders need to read акты inline. A PDF is still safe here because
    // (1) only real PDFs are stored (checked by magic bytes on upload), (2) it is served
    // with its exact type + nosniff, so it can never be treated as HTML, (3) only signed-in
    // founders can fetch it, and (4) PDF scripting runs inside the viewer's own sandbox,
    // not with this site's origin.
    // (next.config.ts leaves this route's CSP to it; X-Frame-Options: DENY still applies to both.)
    if (file.contentType !== "application/pdf") {
      headers["content-security-policy"] = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";
    }
    return new Response(bytes as BodyInit, { status: 200, headers });
  });
}
