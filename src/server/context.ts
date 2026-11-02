import "server-only";
import { getCurrentUser, requireUser } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { makeContext, type ServiceContext } from "@/server/services/context";

/** Pages & server actions: redirects to /login when signed out. */
export async function getPageContext(): Promise<ServiceContext> {
  const user = await requireUser();
  return makeContext(await getDb(), user);
}

/** API routes: null when signed out (caller returns 401 JSON). */
export async function getApiContext(): Promise<ServiceContext | null> {
  const user = await getCurrentUser();
  return user ? makeContext(await getDb(), user) : null;
}
