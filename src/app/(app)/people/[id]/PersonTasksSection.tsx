import Link from "next/link";
import { NewTaskPanel } from "@/components/tasks/NewTaskPanel";
import { TaskList } from "@/components/tasks/TaskList";
import { TeamCountsLine } from "@/components/tasks/TeamBoard";
import { toTaskItem } from "@/components/tasks/types";
import { Section } from "@/components/ui";
import { today, type ServiceContext } from "@/server/services/context";
import { getTaskFormOptions } from "@/server/services/options";
import { getPersonTasks } from "@/server/services/team-tasks";

/** Person page → Tasks (founders only): open, overdue and recently done tasks, and "Assign a task". */
export async function PersonTasksSection({ ctx, personId, left }: { ctx: ServiceContext; personId: string; left: boolean }) {
  const [data, options] = await Promise.all([getPersonTasks(ctx, personId), getTaskFormOptions(ctx)]);
  const day = today(ctx);
  const { group } = data;
  const lists = [
    { key: "overdue", title: "Overdue", tasks: data.overdue, empty: "Nothing overdue." },
    { key: "open", title: "Open", tasks: data.open, empty: "No other open tasks." },
    { key: "done", title: "Done in the last 7 days", tasks: data.doneRecent, empty: "Nothing done this week." },
  ];
  return (
    <Section title="Tasks" count={group.counts.open} tone={group.counts.overdue > 0 ? "risk" : undefined}>
      <div className="mb-3 space-y-3" data-testid="person-tasks">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TeamCountsLine counts={group.counts} />
          <Link href={`/tasks?view=team&person=${encodeURIComponent(data.assignee)}`} className="text-[13px] text-accent hover:underline">
            See in Team view
          </Link>
        </div>
        {!left && (
          <NewTaskPanel
            options={options}
            label="Assign a task"
            defaults={{ visibility: "shared", companyId: data.companyId ?? undefined, assignee: data.assignee }}
          />
        )}
        {lists.map((l) => (
          <div key={l.key} data-testid={`person-tasks-${l.key}`}>
            <h3 className="eyebrow mb-1.5">
              {l.title} · <span className="num">{l.tasks.length}</span>
            </h3>
            <TaskList tasks={l.tasks.map(toTaskItem)} today={day} options={options} empty={l.empty} />
          </div>
        ))}
      </div>
    </Section>
  );
}
