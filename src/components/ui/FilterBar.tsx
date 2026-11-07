"use client";

/**
 * FilterBar — the list filter of Tasks and Routines (WMS style), top to bottom:
 *
 *   status tabs with counts      Active · 12   Paused · 2   Ended · 1   All · 15
 *   Quick filters                (Due today) (Missed) (Has comments) …        toggle chips
 *   My filters                   (Kiwi overdue ×) (+ Save current)          saved per founder
 *   [Search…]  [Condition · 2]  [Sort ▾]
 *
 * Everything lives in the URL (shareable, Back works): `status`, `quick` (comma list), `search`,
 * `company`, `who` ("person:<id>" / "user:<id>"), `from`, `to`, `sort`, plus the page's own
 * `keep` params (e.g. the task view). The page reads them on the server. "Condition" opens a
 * panel: company, person (limited to the chosen company's people), status, date range.
 * Saved filters are kept in this browser (localStorage, one list per founder and page).
 * On a phone each chip row scrolls sideways on its own; the page never does.
 */
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import { Icon } from "@/components/Icon";

export interface FilterOption {
  value: string;
  label: string;
}
export interface FilterPerson extends FilterOption {
  /** Companies the person works for; null = any (founders). */
  companyIds: string[] | null;
}

export interface FilterBarProps {
  /** Accessible name of the bar ("Filter routines"). */
  label: string;
  path: string;
  /** The current filter params (as read by the page). */
  query: Record<string, string | undefined>;
  /** Params that always stay (e.g. `view`) — not filters, not cleared, not saved. */
  keep?: string[];
  tabs: (FilterOption & { count: number })[];
  /** The active tab's value ("" = the default tab). */
  status: string;
  quick: FilterOption[];
  /** localStorage key of the saved filters (include the founder's id). */
  savedKey: string;
  searchPlaceholder: string;
  companies: { id: string; name: string }[];
  people: FilterPerson[];
  /** Finer statuses for the Condition panel (omit: none). */
  statuses?: FilterOption[];
  dateLabel: string;
  sorts: FilterOption[];
}

const FILTER_KEYS = ["status", "quick", "search", "company", "who", "from", "to", "sort"] as const;

interface Saved {
  name: string;
  qs: string;
}

function readSaved(key: string): Saved[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is Saved => !!x && typeof x.name === "string" && typeof x.qs === "string") : [];
  } catch {
    return [];
  }
}
function writeSaved(key: string, list: Saved[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Private mode / storage full: saved filters are a convenience only.
  }
}

const chip = (on: boolean) =>
  `inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ${
    on ? "border-accent bg-accent-soft text-ink" : "border-line text-muted hover:border-ink/30 hover:text-ink"
  }`;

export function FilterBar(props: FilterBarProps) {
  const { label, path, query, keep = [], tabs, status, quick, savedKey, searchPlaceholder, companies, people, statuses, dateLabel, sorts } = props;
  const router = useRouter();
  const [, start] = useTransition();
  const uid = useId();

  /** The URL with `changes` applied (empty values removed). */
  const href = (changes: Record<string, string | null | undefined> = {}, opts: { onlyKeep?: boolean } = {}) => {
    const p = new URLSearchParams();
    for (const k of keep) if (query[k]) p.set(k, query[k]!);
    if (!opts.onlyKeep) for (const k of FILTER_KEYS) if (query[k]) p.set(k, query[k]!);
    for (const [k, v] of Object.entries(changes)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return qs ? `${path}?${qs}` : path;
  };
  const go = (changes: Record<string, string | null | undefined>, replace = false) =>
    start(() => (replace ? router.replace(href(changes), { scroll: false }) : router.push(href(changes), { scroll: false })));

  const activeQuick = (query.quick ?? "").split(",").filter(Boolean);
  const toggleQuick = (v: string) => {
    const next = activeQuick.includes(v) ? activeQuick.filter((x) => x !== v) : [...activeQuick, v];
    go({ quick: next.join(",") });
  };

  // Search: Enter applies at once; typing applies after a pause (replace: one history entry).
  const [search, setSearch] = useState(query.search ?? "");
  useEffect(() => setSearch(query.search ?? ""), [query.search]);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = (v: string) => {
    setSearch(v);
    if (typing.current) clearTimeout(typing.current);
    typing.current = setTimeout(() => {
      if (v.trim() !== (query.search ?? "")) go({ search: v.trim() }, true);
    }, 400);
  };
  useEffect(() => () => void (typing.current && clearTimeout(typing.current)), []);

  // Saved filters (this browser, per founder).
  const [saved, setSaved] = useState<Saved[]>([]);
  useEffect(() => setSaved(readSaved(savedKey)), [savedKey]);
  const currentQs = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) if (query[k]) p.set(k, query[k]!);
    return p.toString();
  }, [query]);
  const [naming, setNaming] = useState<string | null>(null);
  const summary = () => {
    const bits: string[] = [];
    const tab = tabs.find((t) => t.value === status);
    if (status && tab) bits.push(tab.label);
    for (const q of activeQuick) bits.push(quick.find((x) => x.value === q)?.label ?? q);
    if (query.company) bits.push(companies.find((c) => c.id === query.company)?.name ?? "Company");
    if (query.who) bits.push(people.find((p) => p.value === query.who)?.label ?? "Person");
    if (query.search) bits.push(`“${query.search}”`);
    return bits.join(" · ").slice(0, 60) || "My filter";
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const name = (naming ?? "").trim();
    if (!name) return;
    const next = [...saved.filter((s) => s.name !== name), { name, qs: currentQs }];
    setSaved(next);
    writeSaved(savedKey, next);
    setNaming(null);
  };
  const remove = (name: string) => {
    const next = saved.filter((s) => s.name !== name);
    setSaved(next);
    writeSaved(savedKey, next);
  };
  const keepQs = () => {
    const p = new URLSearchParams();
    for (const k of keep) if (query[k]) p.set(k, query[k]!);
    return p;
  };
  const savedHref = (qs: string) => {
    const p = keepQs();
    for (const [k, v] of new URLSearchParams(qs)) p.set(k, v);
    const s = p.toString();
    return s ? `${path}?${s}` : path;
  };

  // Condition panel.
  const [open, setOpen] = useState(false);
  const [company, setCompany] = useState(query.company ?? "");
  const [who, setWho] = useState(query.who ?? "");
  useEffect(() => {
    setCompany(query.company ?? "");
    setWho(query.who ?? "");
  }, [query.company, query.who, open]);
  // Company → people: only the chosen company's people (founders work everywhere).
  const shownPeople = company ? people.filter((p) => !p.companyIds || p.companyIds.includes(company)) : people;
  const conditions = ["company", "who", "from", "to"].filter((k) => query[k]).length + (statuses && query.status && !tabs.some((t) => t.value === query.status) ? 1 : 0);
  const applyConditions = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const s = (k: string) => String(fd.get(k) ?? "");
    setOpen(false);
    go({ company: s("company"), who: s("who"), from: s("from"), to: s("to"), ...(statuses ? { status: s("status") } : {}) });
  };
  const hasFilters = FILTER_KEYS.some((k) => k !== "sort" && query[k]);

  return (
    <div className="mb-4 min-w-0 space-y-2" role="search" aria-label={label}>
      <nav className="flex gap-1 overflow-x-auto border-b border-line" aria-label="Status">
        {tabs.map((t) => {
          const on = t.value === status;
          return (
            <Link
              key={t.value || "default"}
              href={href({ status: t.value })}
              scroll={false}
              aria-current={on ? "page" : undefined}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium ${on ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              {t.label} · <span className="num">{t.count}</span>
            </Link>
          );
        })}
      </nav>

      {quick.length > 0 && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="eyebrow w-[88px] shrink-0">Quick filters</span>
          <div className="flex min-w-0 flex-nowrap gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Quick filters">
            {quick.map((q) => {
              const on = activeQuick.includes(q.value);
              return (
                <button key={q.value} type="button" aria-pressed={on} className={chip(on)} onClick={() => toggleQuick(q.value)}>
                  {on && <Icon name="check" size={12} />}
                  {q.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex min-w-0 items-center gap-2">
        <span className="eyebrow w-[88px] shrink-0">My filters</span>
        <div className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="My filters">
          {saved.map((s) => (
            <span key={s.name} className={`${chip(s.qs === currentQs && !!currentQs)} pr-1`}>
              <Link href={savedHref(s.qs)} scroll={false} className="hover:underline">
                {s.name}
              </Link>
              <button type="button" className="rounded-full p-0.5 hover:bg-sunk" aria-label={`Remove saved filter ${s.name}`} onClick={() => remove(s.name)}>
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
          {naming !== null ? (
            <form onSubmit={save} className="flex shrink-0 items-center gap-1">
              <input
                autoFocus
                className="input h-7 w-[180px] py-0 text-[12px]"
                aria-label="Name of the saved filter"
                value={naming}
                maxLength={60}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setNaming(null)}
              />
              <button type="submit" className="btn btn-sm">
                Save
              </button>
            </form>
          ) : hasFilters ? (
            <button type="button" className={chip(false)} onClick={() => setNaming(summary())}>
              + Save current
            </button>
          ) : (
            saved.length === 0 && <span className="whitespace-nowrap text-[12px] text-muted">Set filters, then save them here.</span>
          )}
        </div>
      </div>

      <div className="relative flex flex-wrap items-center gap-2">
        <form
          className="min-w-[180px] flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (typing.current) clearTimeout(typing.current);
            go({ search: search.trim() });
          }}
        >
          <label htmlFor={`${uid}-search`} className="sr-only">
            Search
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
              <Icon name="search" size={15} />
            </span>
            <input id={`${uid}-search`} type="search" className="input pl-8" placeholder={searchPlaceholder} value={search} onChange={(e) => onSearch(e.target.value)} />
          </div>
        </form>
        <button type="button" className={`btn ${conditions ? "border-accent" : ""}`} aria-expanded={open} aria-controls={`${uid}-cond`} onClick={() => setOpen((o) => !o)}>
          Condition{conditions ? ` · ${conditions}` : ""}
        </button>
        <label className="sr-only" htmlFor={`${uid}-sort`}>
          Sort
        </label>
        <select id={`${uid}-sort`} className="input w-auto" value={query.sort ?? ""} onChange={(e) => go({ sort: e.target.value })}>
          {sorts.map((s, i) => (
            <option key={s.value} value={i === 0 ? "" : s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {hasFilters && (
          <Link href={href({}, { onlyKeep: true })} scroll={false} className="text-[12px] text-muted hover:text-ink">
            Clear all
          </Link>
        )}

        {open && (
          <form
            id={`${uid}-cond`}
            onSubmit={applyConditions}
            aria-label="Condition"
            className="card absolute right-0 top-full z-30 mt-1 grid w-[min(420px,calc(100vw-32px))] gap-3 p-3 text-[13px] shadow-[var(--shadow)] sm:grid-cols-2"
          >
            <label className="flex flex-col gap-1">
              <span className="label">Company</span>
              <select
                name="company"
                className="input"
                value={company}
                onChange={(e) => {
                  const c = e.target.value;
                  setCompany(c);
                  const p = people.find((x) => x.value === who);
                  if (c && p && p.companyIds && !p.companyIds.includes(c)) setWho("");
                }}
              >
                <option value="">All companies</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">Person</span>
              <select name="who" className="input" value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Everyone</option>
                {shownPeople.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {statuses && (
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="label">Status</span>
                <select name="status" className="input" defaultValue={query.status ?? ""}>
                  {statuses.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className="label">{dateLabel} from</span>
              <input type="date" name="from" className="input" defaultValue={query.from ?? ""} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{dateLabel} to</span>
              <input type="date" name="to" className="input" defaultValue={query.to ?? ""} />
            </label>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Apply
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
