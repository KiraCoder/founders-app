import { Tag } from "@/components/ui";
import type { PersonView } from "@/server/services/people";

export function PeopleList({ people, showCompanies = true }: { people: PersonView[]; showCompanies?: boolean }) {
  if (people.length === 0) {
    return <div className="card px-4 py-6 text-center text-[13px] text-muted">No people yet.</div>;
  }
  return (
    <ul className="card divide-y divide-line">
      {people.map((p) => (
        <li key={p.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-sunk text-[13px] font-semibold text-muted">
            {p.fullName.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.fullName}</span>
              {p.isUser && <Tag tone="ok">App user</Tag>}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {p.roles.map((r) => (
                <Tag key={`${r.companyId}-${r.role}`}>
                  {r.title ?? r.role}
                  {showCompanies ? ` · ${r.companyName}` : ""}
                </Tag>
              ))}
            </div>
            {p.notes && <p className="mt-1 text-[12px] text-muted">{p.notes}</p>}
          </div>
          <div className="text-right text-[12px] text-muted">
            {p.phone && <div className="num">{p.phone}</div>}
            {p.telegramHandle && <div>@{p.telegramHandle.replace(/^@/, "")}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}
