import { redirect } from "next/navigation";

/** Old "New routine" page: creating now happens in a dialog on the Routines page (prefilled from `who` / `company`). */
export default async function NewRoutinePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams({ new: "1" });
  if (sp.who) q.set("who", sp.who);
  if (sp.company) q.set("company", sp.company);
  redirect(`/routines?${q.toString()}`);
}
