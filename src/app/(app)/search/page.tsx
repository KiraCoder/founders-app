import Link from "next/link";
import { TaskList } from "@/components/tasks/TaskList";
import { toTaskItem } from "@/components/tasks/types";
import { PageHeader, Section } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { today } from "@/server/services/context";
import { getTaskFormOptions } from "@/server/services/options";
import { search } from "@/server/services/search";

export const metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const ctx = await getPageContext();
  const [results, options] = await Promise.all([search(ctx, q), getTaskFormOptions(ctx)]);
  const total = results.companies.length + results.projects.length + results.tasks.length;

  return (
    <>
      <PageHeader eyebrow="Search" title={q ? `“${results.q}”` : "Search"} />
      <form action="/search" className="mb-6 flex gap-2 md:hidden">
        <input name="q" defaultValue={q} type="search" className="input" placeholder="Search…" aria-label="Search" />
        <button className="btn" type="submit">
          Go
        </button>
      </form>
      {!q && <p className="text-[13px] text-muted">Type in the search box to find tasks, projects and companies.</p>}
      {q && total === 0 && <p className="text-[13px] text-muted">Nothing found.</p>}
      {results.companies.length > 0 && (
        <Section title="Companies" count={results.companies.length}>
          <ul className="card divide-y divide-line">
            {results.companies.map((c) => (
              <li key={c.id}>
                <Link href={`/companies/${c.slug}`} className="block px-4 py-2.5 hover:bg-sunk">
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {results.projects.length > 0 && (
        <Section title="Projects" count={results.projects.length}>
          <ul className="card divide-y divide-line">
            {results.projects.map((p) => (
              <li key={p.id}>
                <Link href={`/projects/${p.id}`} className="block px-4 py-2.5 hover:bg-sunk">
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {results.tasks.length > 0 && (
        <Section title="Tasks" count={results.tasks.length}>
          <TaskList tasks={results.tasks.map(toTaskItem)} today={today(ctx)} options={options} />
        </Section>
      )}
    </>
  );
}
