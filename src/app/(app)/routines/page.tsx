import { notFound } from "next/navigation";
import { NewRoutineButton } from "@/components/routines/RoutineActions";
import { RoutinesList } from "@/components/routines/RoutinesList";
import { ActionForm } from "@/components/staff/ActionForm";
import { FilterBar } from "@/components/ui/FilterBar";
import { PageHeader, Section } from "@/components/ui";
import { todayInTimeZone } from "@/lib/dates";
import { readListFilters } from "@/lib/list-filters";
import { getPageContext } from "@/server/context";
import { canManageRoutines } from "@/server/services/access";
import { exampleRoutineAvailable, listRoutines, routineFormOptions, type RoutineView } from "@/server/services/routines";
import { createExampleRoutineAction } from "./actions";

export const metadata = { title: "Routines" };
export const dynamic = "force-dynamic";

/** Status tabs: "" = Active (the default), All = every routine that is not archived. */
const TABS = [
  { value: "", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
] as const;
const CONDITION_STATUSES = [...TABS.map((t) => ({ value: t.value, label: t.label })), { value: "archived", label: "Archived" }, { value: "everything", label: "All, archived too" }];
const QUICK = [
  { value: "today", label: "Due today" },
  { value: "missed", label: "Missed" },
  { value: "comments", label: "Has comments" },
  { value: "cant", label: "Can't (❌)" },
] as const;
const SORTS = [
  { value: "title", label: "Title" },
  { value: "newest", label: "Newest first" },
  { value: "due", label: "Due soonest" },
] as const;

function inTab(v: RoutineView, tab: string): boolean {
  if (tab === "everything") return true;
  if (tab === "archived") return v.status === "archived";
  if (v.status === "archived") return false;
  if (tab === "all") return true;
  return v.status === (tab || "active");
}

/** A quick filter on the routine as listed (latest run, comments, next ask). */
function quickMatch(v: RoutineView, q: string, now: Date): boolean {
  const run = v.today ?? v.lastRun;
  switch (q) {
    case "today":
      return !!v.nextDueAt && todayInTimeZone(v.nextDueAt, v.routine.timezone) === todayInTimeZone(now, v.routine.timezone);
    case "missed":
      return run?.status === "missed";
    case "comments":
      return v.commentsCount > 0;
    case "cant":
      return !!run && Object.values(run.itemStates ?? {}).some((s) => s.state === "cant");
    default:
      return true;
  }
}

export default async function RoutinesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!canManageRoutines(ctx)) notFound();
  const sp = await searchParams;
  const lf = readListFilters(sp, { statuses: CONDITION_STATUSES.map((s) => s.value).filter(Boolean), quick: QUICK.map((q) => q.value), sorts: SORTS.map((s) => s.value) });
  const [items, options] = await Promise.all([
    listRoutines(ctx, { companyId: lf.company, personId: lf.personId, userId: lf.userId, status: "all" }),
    routineFormOptions(ctx),
  ]);
  // An unfiltered list already shows whether the example exists (no extra query then).
  const example = await exampleRoutineAvailable(ctx, lf.company || lf.personId || lf.userId ? undefined : items);

  // Search, quick filters and the date range narrow the list; the tabs count what is left.
  const needle = lf.search.toLowerCase();
  const narrowed = items.filter(
    (v) =>
      (!needle || [v.routine.title, v.assigneeName, v.companyName ?? ""].some((x) => x.toLowerCase().includes(needle))) &&
      lf.quick.every((q) => quickMatch(v, q, ctx.now)) &&
      (!lf.from || (!!v.nextDueAt && todayInTimeZone(v.nextDueAt, v.routine.timezone) >= lf.from)) &&
      (!lf.to || (!!v.nextDueAt && todayInTimeZone(v.nextDueAt, v.routine.timezone) <= lf.to)),
  );
  const shown = narrowed.filter((v) => inTab(v, lf.status));
  if (lf.sort === "newest") shown.sort((a, b) => b.routine.createdAt.getTime() - a.routine.createdAt.getTime());
  else if (lf.sort === "due") shown.sort((a, b) => (a.nextDueAt?.getTime() ?? Infinity) - (b.nextDueAt?.getTime() ?? Infinity));
  const people = [
    ...options.founders.map((f) => ({ value: `user:${f.id}`, label: `${f.name} (founder)`, companyIds: null })),
    ...options.people.map((p) => ({ value: `person:${p.id}`, label: p.name, companyIds: p.companyIds })),
  ];
  const prefillWho = lf.who ?? "";
  const prefillCompany = lf.company ?? "";
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

      <FilterBar
        label="Filter routines"
        path="/routines"
        query={lf.query}
        tabs={TABS.map((t) => ({ value: t.value, label: t.label, count: narrowed.filter((v) => inTab(v, t.value)).length }))}
        status={lf.status}
        quick={QUICK.map((q) => ({ ...q }))}
        savedKey={`fc:filters:routines:${ctx.user.id}`}
        searchPlaceholder="Search title, person, company"
        companies={options.companies}
        people={people}
        statuses={CONDITION_STATUSES}
        dateLabel="Next ask"
        sorts={SORTS.map((s) => ({ ...s }))}
      />

      <Section title="Routines" count={shown.length}>
        <RoutinesList items={shown} options={options} now={ctx.now} empty="No routines match. Create one with + New, or use the Elmurat 1C example." />
      </Section>
    </>
  );
}
