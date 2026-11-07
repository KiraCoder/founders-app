import { notFound } from "next/navigation";
import { NewRoutineButton } from "@/components/routines/RoutineActions";
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

/**
 * Routines — the control center: every routine with its status, who, company, schedule and next
 * ask, the latest run (3/5, missed), comments, and icon actions. "+ New" and ✎ Edit open a dialog.
 * `?new=1` (with `who` / `company`) opens the create dialog prefilled (links from company / person pages).
 */
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
      status: "all", // filtered below by the shown status ("ended" is computed)
    }),
    routineFormOptions(ctx),
    exampleRoutineAvailable(ctx),
  ]);
  const shown = status ? items.filter((v) => status === "all" || v.status === status) : items.filter((v) => v.routine.status !== "archived");
  const prefillWho = sp.who && /^(person|user):[0-9a-f-]{36}$/i.test(sp.who) ? sp.who : "";
  const prefillCompany = sp.company && uuid.test(sp.company) ? sp.company : "";
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
            <NewRoutineButton options={options} openInitially={sp.new === "1"} prefill={{ assignee: prefillWho, companyId: prefillCompany }} />
          </>
        }
      >
        <p className="mt-1 text-[13px] text-muted">
          Recurring jobs: the bot asks the person (in Russian) on each scheduled day, reminds until it is done and tells you when it is not.
        </p>
      </PageHeader>

      <form className="mb-4 flex flex-wrap items-end gap-2" method="get" aria-label="Filter routines">
        <label className="flex min-w-[140px] flex-1 flex-col gap-1 sm:flex-none">
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
        <label className="flex min-w-[140px] flex-1 flex-col gap-1 sm:flex-none">
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
        <label className="flex min-w-[140px] flex-1 flex-col gap-1 sm:flex-none">
          <span className="label">Status</span>
          <select className="input" name="status" defaultValue={sp.status ?? ""}>
            <option value="">Not archived</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="ended">Ended</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </label>
        <button type="submit" className="btn">
          Filter
        </button>
      </form>

      <Section title="Routines" count={shown.length}>
        <RoutinesList items={shown} options={options} now={ctx.now} empty="No routines match. Create one with + New, or use the Elmurat 1C example." />
      </Section>
    </>
  );
}
