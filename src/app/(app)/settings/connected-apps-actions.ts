"use server";

import { revalidatePath } from "next/cache";
import { getPageContext } from "@/server/context";
import { toServiceError } from "@/server/services/errors";
import { revokeConnectedApp } from "@/server/services/oauth";

export interface ConnectedAppState {
  ok?: boolean;
  error?: string;
}

/** Settings → Connected apps: disconnect one of my apps (revokes all its tokens at once). */
export async function revokeConnectedAppAction(grantId: string): Promise<ConnectedAppState> {
  const ctx = await getPageContext();
  try {
    await revokeConnectedApp(ctx, grantId);
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message };
  }
}
