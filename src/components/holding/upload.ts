/** Client helper: uploads one document to /api/v1/holding/files (PDF/JPG/PNG, max 10 MB). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCEPT = "application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png";

export async function uploadHoldingFile(file: File): Promise<{ id: string; name: string } | { error: string }> {
  if (file.size > MAX_UPLOAD_BYTES) return { error: "The file is larger than 10 MB" };
  const fd = new FormData();
  fd.set("file", file);
  try {
    const res = await fetch("/api/v1/holding/files", { method: "POST", body: fd, credentials: "same-origin" });
    const body = (await res.json().catch(() => null)) as { data?: { id: string; name: string }; error?: { message: string } } | null;
    if (!res.ok || !body?.data) return { error: body?.error?.message ?? `Upload failed (${res.status})` };
    return body.data;
  } catch {
    return { error: "Upload failed — check the connection and try again" };
  }
}

export function fileUrl(id: string): string {
  return `/api/v1/holding/files/${id}`;
}
