import { getPageContext } from "@/server/context";
import { canManageStaffBot } from "@/server/services/access";
import type { TaskFormOptions } from "@/server/services/options";
import { taskActivityFor } from "@/server/services/task-activity";
import { TaskListClient } from "./TaskListClient";
import type { TaskItem } from "./types";

/**
 * A list of tasks as a control center (0032): each row shows status, assignee, company, due date,
 * the last message sent to the person and their last answer, comments and checklist progress,
 * with icon buttons (Done, Edit, Open, Chase now, Pause chasing, Archive). Server component: it
 * reads the activity of the listed tasks (the caller already read them through the access rules).
 */
interface Props {
  tasks: TaskItem[];
  today: string;
  options: TaskFormOptions;
  empty?: string;
  showCompany?: boolean;
}

export function TaskList(props: Props) {
  // An empty list needs no data (and renders synchronously, e.g. in static markup).
  if (props.tasks.length === 0) {
    return <div className="card px-4 py-6 text-center text-[13px] text-muted">{props.empty ?? "Nothing here."}</div>;
  }
  return <TaskListWithActivity {...props} />;
}

async function TaskListWithActivity({ tasks, today, options, empty = "Nothing here.", showCompany = true }: Props) {
  const ctx = await getPageContext();
  const activity = tasks.length ? await taskActivityFor(ctx, tasks) : {};
  return (
    <TaskListClient
      tasks={tasks}
      today={today}
      options={options}
      empty={empty}
      showCompany={showCompany}
      activity={JSON.parse(JSON.stringify(activity))}
      canChase={canManageStaffBot(ctx)}
      timeZone={ctx.timeZone}
    />
  );
}
