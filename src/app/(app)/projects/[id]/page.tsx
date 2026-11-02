import Link from "next/link";
import { notFound } from "next/navigation";
import { ProgressBar, ProjectStatusTag } from "@/components/projects/ProjectCard";
import { NewTaskPanel } from "@/components/tasks/NewTaskPanel";
import { TaskList } from "@/components/tasks/TaskList";
import { toTaskItem } from "@/components/tasks/types";
import { PageHeader, Section } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { today } from "@/server/services/context";
import { ServiceError } from "@/server/services/errors";
import { getTaskFormOptions } from "@/server/services/options";
import { getProject } from "@/server/services/projects";
import { listTasks } from "@/server/services/tasks";

export const metadata = { title: "Project" };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getPageContext();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const project = await getProject(ctx, id).catch((err: unknown) => {
    if (err instanceof ServiceError && err.code === "not_found") notFound();
    throw err;
  });
  const [tasks, options] = await Promise.all([
    listTasks(ctx, { projectId: id, status: "any" }),
    getTaskFormOptions(ctx),
  ]);

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/companies/${project.companySlug}?tab=projects`} className="hover:text-ink">
            {project.companyName} · Projects
          </Link>
        }
        title={project.name}
        actions={<ProjectStatusTag status={project.status} />}
      >
        {project.description && <p className="mt-1 max-w-2xl text-[13px] text-muted">{project.description}</p>}
      </PageHeader>

      <div className="card mb-6 grid gap-4 p-4 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <p className="eyebrow mb-2">Progress</p>
          <ProgressBar value={project.progress} />
          <p className="num mt-1.5 text-[13px] text-muted">
            {project.progress}% · {project.doneTasks} of {project.totalTasks} tasks done
          </p>
        </div>
        <div>
          <p className="eyebrow">Owner</p>
          <p className="mt-1">{project.ownerName ?? "—"}</p>
        </div>
        <div>
          <p className="eyebrow">Dates</p>
          <p className="num mt-1">
            {project.startDate ?? "—"} → {project.dueDate ?? "—"}
          </p>
        </div>
      </div>

      <Section title="Tasks" count={tasks.length}>
        <div className="mb-3">
          <NewTaskPanel
            options={options}
            label="Add task to project"
            defaults={{ visibility: "shared", companyId: project.companyId, projectId: project.id }}
          />
        </div>
        <TaskList
          tasks={tasks.map(toTaskItem)}
          today={today(ctx)}
          options={options}
          showCompany={false}
          empty="No tasks in this project yet."
        />
      </Section>
    </>
  );
}
