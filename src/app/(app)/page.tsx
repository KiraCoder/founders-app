import Link from "next/link";
import { GroupFreshness } from "@/components/metrics/FreshnessRow";
import { QuickAdd } from "@/components/tasks/QuickAdd";
import { TaskList } from "@/components/tasks/TaskList";
import { toTaskItem } from "@/components/tasks/types";
import { PageHeader, Section } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { companyFreshness } from "@/server/services/metrics";
import { getTaskFormOptions } from "@/server/services/options";
import { getTodaySummary } from "@/server/services/tasks";

export const metadata = { title: "Today" };

function longDate(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

export default async function TodayPage() {
  const ctx = await getPageContext();
  const [summary, options, freshness] = await Promise.all([getTodaySummary(ctx), getTaskFormOptions(ctx), companyFreshness(ctx)]);
  const list = (items: typeof summary.overdue, empty: string) => (
    <TaskList tasks={items.map(toTaskItem)} today={summary.today} options={options} empty={empty} />
  );

  return (
    <>
      <PageHeader eyebrow={longDate(summary.today)} title={`Good day, ${ctx.user.shortName}`}>
        <p className="mt-1 text-[13px] text-muted">
          <span className="num">{summary.overdue.length}</span> overdue ·{" "}
          <span className="num">{summary.dueToday.length}</span> due today ·{" "}
          <span className="num">{summary.thisWeek.length}</span> this week
        </p>
      </PageHeader>

      <div className="mb-6">
        <QuickAdd />
      </div>

      <div className="grid gap-x-6 lg:grid-cols-2">
        <div>
          <Section title="Overdue" count={summary.overdue.length} tone="risk">
            {list(summary.overdue, "Nothing overdue. Nice.")}
          </Section>
          <Section title="Due today" count={summary.dueToday.length} tone="warn">
            {list(summary.dueToday, "Nothing due today.")}
          </Section>
        </div>
        <div>
          <Section title="Due this week" count={summary.thisWeek.length} tone="info">
            {list(summary.thisWeek, "Nothing due in the next 7 days.")}
          </Section>
          <Section
            title="My personal todos"
            count={summary.personal.length}
            action={
              <Link href="/tasks?view=my" className="text-[12px] text-accent hover:underline">
                All →
              </Link>
            }
          >
            {list(summary.personal, "No personal todos. Use quick add above.")}
          </Section>
          {freshness.length > 0 && (
            <Section
              title="Company numbers"
              action={
                <Link href="/companies" className="text-[12px] text-accent hover:underline">
                  Companies →
                </Link>
              }
            >
              <GroupFreshness rows={freshness} />
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
