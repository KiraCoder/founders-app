import Link from "next/link";
import { Tag, type Tone } from "@/components/ui";
import type { ProjectView } from "@/server/services/projects";

const STATUS_TONE: Record<string, Tone> = { planned: "info", active: "ok", on_hold: "warn", done: "neutral", cancelled: "neutral" };
const STATUS_LABEL: Record<string, string> = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  done: "Done",
  cancelled: "Cancelled",
};

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunk" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-accent" style={{ width: `${value}%` }} />
    </div>
  );
}

export function ProjectStatusTag({ status }: { status: string }) {
  return <Tag tone={STATUS_TONE[status]}>{STATUS_LABEL[status] ?? status}</Tag>;
}

export function ProjectCard({ project }: { project: ProjectView }) {
  return (
    <Link href={`/projects/${project.id}`} className="card block p-4 hover:border-accent">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-medium">{project.name}</h3>
        <ProjectStatusTag status={project.status} />
      </div>
      {project.description && <p className="mb-3 line-clamp-2 text-[13px] text-muted">{project.description}</p>}
      <ProgressBar value={project.progress} />
      <div className="mt-2 flex justify-between text-[12px] text-muted">
        <span className="num">
          {project.doneTasks}/{project.totalTasks} tasks done
        </span>
        {project.dueDate && <span className="num">Due {project.dueDate}</span>}
      </div>
    </Link>
  );
}
