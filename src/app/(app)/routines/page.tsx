import { notFound } from "next/navigation";
import { NewRoutineButton } from "@/components/routines/RoutineActions";
import { RoutineStatusIcon } from "@/components/routines/RoutineInline";
import { RoutinesList, type RoutineGrouping } from "@/components/routines/RoutinesList";
import { ActionForm } from "@/components/staff/ActionForm";
import { CompanyDot, InitialsAvatar, PageHeader } from "@/components/ui";
import { ListToolbar, type ToolbarChip } from "@/components/ui/ListToolbar";
import { todayInTimeZone } from "@/lib/dates";
import { getPageContext } from "@/server/context";
import { canManageRoutines } from "@/server/services/access";
import { exampleRoutineAvailable, listRoutines, routineFormOptions, type RoutineView } from "@/server/services/routines";
import { createExampleRoutineAction } from "./actions";

export const metadata = { title: "Routines" };
export const dynamic = "force-dynamic";

/** View chips: "" = Active (the default); All = every routine that is not archived. */
const VIEWS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "ended", label: "Ended" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
] as const;
const QUICK = [
  { value: "today", label: "Due today" },
  { value: "missed", label: "Missed" },
  { value: "comments", label: "Has comments" },
  { value: "cant", label: "Can't (❌)" },
] as const;
const GROUPINGS = [
  { value: "status", label: "Status" },
  { value: "assignee", label: "Assignee" },
  { value: "company", label: "Company" },
  { value: "none", label: "No grouping" },
];
const ORDERINGS = [
  { value: "title", label: "Title" },
  { value: "newest", label: "Newest first" },
  { value: "due", label: "Next ask" },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inView(v: RoutineView, view: string): boolean {
  if (view === "archived") return v.status === "archived";
  if (v.status === "archived") return false;
  if (view === "all") return true;
  return v.status === view;
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
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");
  const list = (k: string) => str(k).split(",").map((s) => s.trim()).filter(Boolean);
  // Old links: status=paused|ended|archived|all|everything.
  const oldStatus = str("status") === "everything" ? "all" : str("status");
  const view = (VIEWS.some((v) => v.value === str("view")) ? str("view") : VIEWS.some((v) => v.value === oldStatus) ? oldStatus : "active") as (typeof VIEWS)[number]["value"];
  const whoRaw = str("who");
  const who = /^(user|person):[0-9a-f-]{36}$/i.test(whoRaw) ? whoRaw : "";
  const companies = list("company").filter((c) => UUID.test(c));
  const quick = list("quick").filter((q) => QUICK.some((x) => x.value === q));
  const search = str("search").slice(0, 200);
  const group = (GROUPINGS.some((g) => g.value === str("group")) ? str("group") : "status") as RoutineGrouping;
  const order = ORDERINGS.some((o) => o.value === (str("order") || str("sort"))) ? str("order") || str("sort") : "title";
  const query: Record<string, string> = {};
  if (view !== "active") query.view = view;
  if (who) query.who = who;
  if (companies.length) query.company = companies.join(",");
  if (quick.length) query.quick = quick.join(",");
  if (search) query.search = search;
  if (group !== "status") query.group = group;
  if (order !== "title") query.order = order;

  const [items, options] = await Promise.all([
    listRoutines(ctx, { personId: who.startsWith("person:") ? who.slice(7) : undefined, userId: who.startsWith("user:") ? who.slice(5) : undefined, status: "all" }),
    routineFormOptions(ctx),
  ]);
  // An unfiltered list already shows whether the example exists (no extra query then).
  const example = await exampleRoutineAvailable(ctx, companies.length || who ? undefined : items);

  // Company, search and quick filters narrow the list; the view chips count what is left.
  const needle = search.toLowerCase();
  const narrowed = items.filter(
    (v) =>
      (!companies.length || (v.routine.companyId && companies.includes(v.routine.companyId))) &&
      (!needle || [v.routine.title, v.assigneeName, v.companyName ?? ""].some((x) => x.toLowerCase().includes(needle))) &&
      quick.every((q) => quickMatch(v, q, ctx.now)),
  );
  const shown = narrowed.filter((v) => inView(v, view));
  if (order === "newest") shown.sort((a, b) => b.routine.createdAt.getTime() - a.routine.createdAt.getTime());
  else if (order === "due") shown.sort((a, b) => (a.nextDueAt?.getTime() ?? Infinity) - (b.nextDueAt?.getTime() ?? Infinity));
  else shown.sort((a, b) => a.routine.title.localeCompare(b.routine.title));

  const views: ToolbarChip[] = VIEWS.map((v) => ({
    value: v.value,
    label: v.label,
    count: narrowed.filter((x) => inView(x, v.value)).length,
    icon: v.value === "all" ? undefined : <RoutineStatusIcon status={v.value} size={12} />,
  }));
  // Person chips: founders, then people with routines (only the chosen companies' people).
  const withRoutines = new Set(items.map((v) => v.routine.assigneePersonId).filter(Boolean));
  const persons: ToolbarChip[] = [
    ...options.founders.map((f) => ({ value: `user:${f.id}`, label: f.name, icon: <InitialsAvatar name={f.name} size="xs" /> })),
    ...options.people
      .filter((p) => withRoutines.has(p.id) && (!companies.length || !p.companyIds.length || p.companyIds.some((c) => companies.includes(c))))
      .map((p) => ({ value: `person:${p.id}`, label: p.name, count: items.filter((v) => v.routine.assigneePersonId === p.id && v.status !== "archived").length, icon: <InitialsAvatar name={p.name} size="xs" tone="neutral" /> })),
  ];
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
            <NewRoutineButton options={options} openInitially={sp.new === "1"} prefill={{ assignee: who, companyId: companies.length === 1 ? companies[0]! : "" }} />
          </>
        }
      >
        <p className="mt-1 text-[13px] text-muted">
          Recurring jobs: the bot asks the person (in Russian) on each scheduled day, reminds until it is done and tells you when it is not.
        </p>
      </PageHeader>

      <ListToolbar
        label="Filter routines"
        path="/routines"
        query={query}
        views={views}
        view="active"
        persons={persons}
        who={who}
        filters={[
          { param: "company", label: "Company", options: options.companies.map((c) => ({ value: c.id, label: c.name, icon: <CompanyDot color="var(--muted)" size={7} /> })) },
          { param: "quick", label: "Run", options: QUICK.map((q) => ({ value: q.value, label: q.label })) },
        ]}
        display={{ groupings: GROUPINGS, orderings: ORDERINGS, defaults: { group: "status", order: "title" } }}
        savedKey={`fc:filters:routines:${ctx.user.id}`}
        searchPlaceholder="Search title, person, company"
      />

      <p className="eyebrow mb-2">
        <span className="num">{shown.length}</span> {shown.length === 1 ? "routine" : "routines"}
      </p>
      <RoutinesList items={shown} options={options} now={ctx.now} group={group} empty="No routines match. Create one with + New, or use the Elmurat 1C example." />
    </>
  );
}
