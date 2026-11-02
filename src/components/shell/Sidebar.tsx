import Link from "next/link";
import type { Company } from "@/server/db/schema";
import { CompanyDot } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { NavLink } from "./NavLink";

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p className="eyebrow mb-1 px-2.5">{title}</p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

export function Sidebar({ companies }: { companies: Pick<Company, "slug" | "name" | "color" | "status">[] }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[240px] shrink-0 flex-col border-r border-line bg-surface md:flex">
      <Link href="/" className="flex h-14 items-center gap-2.5 border-b border-line px-4">
        <span className="grid size-7 place-items-center rounded-[8px] bg-accent text-[13px] font-bold text-accent-ink">F</span>
        <span className="text-[15px] font-semibold">Founder Cockpit</span>
      </Link>
      <nav className="flex-1 overflow-y-auto px-2 py-4" aria-label="Main">
        <Group title="Workspace">
          <NavLink href="/" exact>
            <Icon name="today" /> Today
          </NavLink>
          <NavLink href="/tasks">
            <Icon name="tasks" /> My tasks
          </NavLink>
        </Group>
        <Group title="Companies">
          {companies.map((c) => (
            <NavLink key={c.slug} href={`/companies/${c.slug}`}>
              <span className="grid size-[18px] place-items-center">
                <CompanyDot color={c.color} />
              </span>
              <span className="truncate">{c.name}</span>
              {c.status === "planned" && <span className="ml-auto text-[11px] text-muted">planned</span>}
            </NavLink>
          ))}
          <NavLink href="/companies" exact className="text-muted">
            <Icon name="building" /> All companies
          </NavLink>
        </Group>
        <Group title="Group">
          <NavLink href="/holding">
            <Icon name="holding" /> Holding
          </NavLink>
          <NavLink href="/people">
            <Icon name="people" /> People
          </NavLink>
          <NavLink href="/org">
            <Icon name="org" /> Org structure
          </NavLink>
          <NavLink href="/ai-roles">
            <Icon name="sparkles" /> AI roles
          </NavLink>
        </Group>
      </nav>
    </aside>
  );
}
