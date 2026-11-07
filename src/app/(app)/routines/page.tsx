import Link from "next/link";
import { notFound } from "next/navigation";
import { RoutinesList } from "@/components/routines/RoutinesList";
import { ActionForm } from "@/components/staff/ActionForm";
import { PageHeader, Section } from "@/components/ui";
import { ROUTINE_STATUSES, type RoutineStatus } from "@/lib/routines";
import { getPageContext } from "@/server/context";
import { canManageRoutines } from "@/server/services/access";
import { exampleRoutineAvailable, listRoutines, routineFormOptions } from "@/server/services/routines";
import { createExampleRoutineAction } from "./actions";

export const metadata = { title: "Routines" };
export const dynamic = "force-dynamic";

export default async function RoutinesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await getPageContext();
  if (!canManageRoutines(ctx)) notFound();
  const sp = await searchParams;
  const status = (ROUTINE_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as RoutineStatus) : sp.status === "all" ? "all" : null;
  const [person, user] = sp.who?.startsWith("person:") ? [sp.who.slice(7), null] : sp.who?.startsWith("user:") ? [null, sp.who.slice(5)] : [null, null];
  const uuid = /^[0-9a-f-]{36}$/i;
  const [items, options, example] = await Promise.all([
    listRoutines(ctx, {
      companyId: sp.company && uuid.test(sp.company) ? sp.company : null,
      personId: person && uuid.test(person) ? person : null,
      userId: user && uuid.test(user) ? user : null,
      // Archived ones only when asked for.
      status: status ?? "all",
    }),
    routineFormOptions(ctx),
    exampleRoutineAvailable(ctx),
  ]);
  const shown = status ? items : items.filter((v) => v.routine.status !== "archived");
  return (
    <>
      <PageHeader
        title="Routines"
        actions={
          <>
            {example && (
              <ActionForm action={createExampleRoutineAction}>
                <button type="submit" className="btn">
                  Use example: Elmurat 1C
                </button>
              </ActionForm>
            )}
            <Link href="/routines/new" className="btn btn-primary">
              New routine
            </Link>
          </>
        }
      >
        <p className="mt-1 text-[13px] text-muted">
          Recurring jobs: the bot asks the person (in Russian) on each scheduled day, reminds until it is done and tells you when it is not.
        </p>
      </PageHeader>

      <form className="mb-4 flex flex-wrap items-end gap-2" method="get" aria-label="Filter routines">
        <label className="flex flex-col gap-1">
          <span className="label">Company</span>
          <select className="input" name="company" defaultValue={sp.company ?? ""}>
            <option value="">All</option>
            {options.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Who</span>
          <select className="input" name="who" defaultValue={sp.who ?? ""}>
            <option value="">Everyone</option>
            {options.people.map((p) => (
              <option key={p.id} value={`person:${p.id}`}>
                {p.name}
              </option>
            ))}
            {options.founders.map((f) => (
              <option key={f.id} value={`user:${f.id}`}>
                {f.name} (founder)
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Status</span>
          <select className="input" name="status" defaultValue={sp.status ?? ""}>
            <option value="">Active and paused</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </label>
        <button type="submit" className="btn">
          Filter
        </button>
      </form>

      <Section title="Routines" count={shown.length}>
        <RoutinesList items={shown} empty="No routines match. Create one, or use the Elmurat 1C example." />
      </Section>
    </>
  );
}
