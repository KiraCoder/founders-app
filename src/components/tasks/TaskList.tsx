import { getPageContext } from "@/server/context";
import { canManageStaffBot } from "@/server/services/access";
import type { TaskFormOptions } from "@/server/services/options";
import { taskActivityFor, type TaskActivity } from "@/server/services/task-activity";
import { TaskBoard, type Grouping, type Ordering, type Property } from "./TaskBoard";
import type { TaskItem } from "./types";

/**
 * A list of tasks (Today, a project, a company, a person, search): the same Linear-style rows as
 * the Tasks page (every property changes inline), without group headers unless `group` is given.
 * Server component: it reads the activity of the listed tasks (the caller already read them
 * through the access rules).
 */
interface Props {
  tasks: TaskItem[];
  today: string;
  options: TaskFormOptions;
  empty?: string;
  showCompany?: boolean;
  /**
   * The activity of these tasks when the page already read it (Today reads it once for its four
   * lists: queries are serial, so one read beats four). Otherwise the list reads its own.
   */
  activity?: Record<string, TaskActivity>;
  /** The Tasks page: group headers, "+" per group, the bulk bar. */
  full?: boolean;
  group?: Grouping;
  order?: Ordering;
  hidden?: readonly Property[];
  statusScope?: readonly string[];
  createDefaults?: { companyId?: string | null; projectId?: string | null };
}

export function TaskList(props: Props) {
  // An empty plain list needs no data (and renders synchronously, e.g. in static markup).
  if (props.tasks.length === 0 && !props.full) {
    return <div className="card px-4 py-6 text-center text-[13px] text-muted">{props.empty ?? "Nothing here."}</div>;
  }
  return <TaskListWithActivity {...props} />;
}

async function TaskListWithActivity({ tasks, today, options, empty = "Nothing here.", showCompany = true, activity: given, full = false, group, order, hidden, statusScope, createDefaults }: Props) {
  const ctx = await getPageContext();
  const all = given ?? (tasks.length ? await taskActivityFor(ctx, tasks) : {});
  const activity = given ? Object.fromEntries(tasks.flatMap((t) => (all[t.id] ? [[t.id, all[t.id]!]] : []))) : all;
  const hide = new Set<Property>(hidden ?? (full ? ["updated"] : ["updated", "created"]));
  if (!showCompany) hide.add("company");
  return (
    <TaskBoard
      tasks={tasks}
      activity={JSON.parse(JSON.stringify(activity))}
      options={options}
      today={today}
      timeZone={ctx.timeZone}
      canChase={canManageStaffBot(ctx)}
      empty={empty}
      full={full}
      group={group}
      order={order}
      hidden={[...hide]}
      statusScope={statusScope}
      createDefaults={createDefaults}
    />
  );
}
