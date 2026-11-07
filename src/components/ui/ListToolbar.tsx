"use client";

/**
 * ListToolbar — the top bar of Tasks and Routines (0034, Linear style, our tokens):
 *
 *   [Active · 12] [Backlog · 3] [All · 40]  |  (Me) (Talant) (Edil) …        [Search] [Filter] [Display]
 *   (Status: Todo, In Progress ×) (Label: Photos ×) …   My filters: (Kiwi overdue ×) (+ Save current)
 *
 * Everything lives in the URL (shareable, Back works): `view`, `who`, one param per filter
 * (comma lists), `search`, and the display params (`group`, `order`, `hide`). The page reads them
 * on the server. Saved filters ("my filters") are kept in this browser (localStorage, one list per
 * founder and page). On a phone each chip row scrolls sideways on its own; the page never does.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { Menu, type MenuOption } from "./Menu";
import { toolbarChip } from "./toolbar-chip";

export interface ToolbarChip {
  value: string;
  label: string;
  count?: number;
  icon?: ReactNode;
}

export interface FilterField {
  /** URL param ("status"). */
  param: string;
  label: string;
  icon?: ReactNode;
  options: MenuOption[];
  /** One value only (e.g. "Over estimate"). */
  single?: boolean;
}

export interface DisplayConfig {
  groupings?: { value: string; label: string }[];
  orderings?: { value: string; label: string }[];
  properties?: { value: string; label: string }[];
  /** Defaults (not written to the URL). */
  defaults: { group?: string; order?: string; hide?: string[] };
}

export interface ListToolbarProps {
  label: string;
  path: string;
  query: Record<string, string | undefined>;
  views: ToolbarChip[];
  /** The view chip param's default value ("" = no param). */
  view: string;
  persons?: ToolbarChip[];
  who?: string;
  filters: FilterField[];
  display?: DisplayConfig;
  savedKey: string;
  searchPlaceholder: string;
  /** Right of the view chips (e.g. a "Team" link). */
  extra?: ReactNode;
}

const DISPLAY_PARAMS = ["group", "order", "hide"];

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

export function ListToolbar(props: ListToolbarProps) {
  const { label, path, query, views, view, persons = [], who = "", filters, display, savedKey, searchPlaceholder, extra } = props;
  const router = useRouter();
  const [, start] = useTransition();
  const filterParams = useMemo(() => [...filters.map((f) => f.param), "search", "who"], [filters]);

  /** The URL with `changes` applied (empty values removed). */
  const href = (changes: Record<string, string | null | undefined> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
    for (const [k, v] of Object.entries(changes)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return qs ? `${path}?${qs}` : path;
  };
  const go = (changes: Record<string, string | null | undefined>, replace = false) =>
    start(() => (replace ? router.replace(href(changes), { scroll: false }) : router.push(href(changes), { scroll: false })));

  const values = (param: string) => (query[param] ?? "").split(",").filter(Boolean);
  const toggleValue = (f: FilterField, v: string) => {
    const cur = values(f.param);
    const next = f.single ? (cur.includes(v) ? [] : [v]) : cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    go({ [f.param]: next.join(",") }, true);
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

  // A filter picked from the Filter menu opens its own menu at once (a pending pill).
  const [pendingField, setPendingField] = useState<string | null>(null);
  const active = filters.filter((f) => values(f.param).length > 0 || pendingField === f.param);
  const fieldMenu: MenuOption[] = filters.map((f) => ({ value: f.param, label: f.label, icon: f.icon, hint: values(f.param).length ? String(values(f.param).length) : undefined }));

  // Saved filters (this browser, per founder).
  const [saved, setSaved] = useState<Saved[]>([]);
  useEffect(() => setSaved(readSaved(savedKey)), [savedKey]);
  const currentQs = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of ["view", ...filterParams, ...DISPLAY_PARAMS]) if (query[k]) p.set(k, query[k]!);
    return p.toString();
  }, [query, filterParams]);
  const hasFilters = filterParams.some((k) => query[k]) || (!!query.view && query.view !== view);
  const [naming, setNaming] = useState<string | null>(null);
  const summary = () => {
    const bits: string[] = [];
    const vw = views.find((x) => x.value === (query.view ?? ""));
    if (query.view && vw) bits.push(vw.label);
    if (who) bits.push(persons.find((p) => p.value === who)?.label ?? "Person");
    for (const f of filters) {
      const vs = values(f.param);
      if (vs.length) bits.push(`${f.label}: ${vs.map((v) => f.options.find((o) => o.value === v)?.label ?? v).join(", ")}`);
    }
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

  return (
    <div className="mb-3 min-w-0 space-y-2" role="search" aria-label={label}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <nav className="flex min-w-0 max-w-full items-center gap-0.5 overflow-x-auto rounded-[10px] border border-line bg-sunk p-0.5" aria-label="Views">
          {views.map((v) => {
            const on = v.value === (query.view ?? view);
            return (
              <Link key={v.value || "default"} href={href({ view: v.value === view ? null : v.value })} scroll={false} aria-current={on ? "page" : undefined} className={toolbarChip(on)}>
                {v.icon}
                {v.label}
                {v.count !== undefined && <span className="num text-muted">{v.count}</span>}
              </Link>
            );
          })}
        </nav>
        {persons.length > 0 && (
          <div className="flex min-w-0 max-w-full flex-1 items-center gap-1 overflow-x-auto sm:flex-wrap sm:overflow-visible" role="group" aria-label="People">
            {persons.map((p) => {
              const on = p.value === who;
              return (
                <Link
                  key={p.value}
                  href={href({ who: on ? null : p.value })}
                  scroll={false}
                  aria-pressed={on}
                  className={`inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                    on ? "border-accent bg-accent-soft font-medium text-ink" : "border-line text-muted hover:border-ink/30 hover:text-ink"
                  }`}
                >
                  {p.icon}
                  {p.label}
                  {p.count !== undefined && <span className="num text-[11.5px] text-muted">{p.count}</span>}
                </Link>
              );
            })}
          </div>
        )}
        <div className="flex w-full min-w-0 items-center gap-1.5 sm:ml-auto sm:w-auto sm:shrink-0">
          {extra}
          <form
            className="relative min-w-0 flex-1 sm:flex-none"
            onSubmit={(e) => {
              e.preventDefault();
              if (typing.current) clearTimeout(typing.current);
              go({ search: search.trim() });
            }}
          >
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted">
              <Icon name="search" size={14} />
            </span>
            <input type="search" className="input h-8 w-full pl-7 text-[13px] sm:w-[200px]" placeholder={searchPlaceholder} aria-label="Search" value={search} onChange={(e) => onSearch(e.target.value)} />
          </form>
          <Menu
            label="Add a filter"
            title="Filter"
            options={fieldMenu}
            value={null}
            searchable
            width={220}
            onSelect={(param) => setPendingField(param)}
            trigger={(p) => (
              <button type="button" {...p} ref={p.ref as (el: HTMLButtonElement | null) => void} className="btn btn-sm gap-1.5">
                <FilterGlyph /> Filter
              </button>
            )}
          />
          {display && <DisplayButton display={display} query={query} go={go} />}
        </div>
      </div>

      {(active.length > 0 || saved.length > 0 || hasFilters) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Active filters">
          {active.map((f) => {
            const vs = values(f.param);
            const names = vs.map((v) => f.options.find((o) => o.value === v)?.label ?? v);
            return (
              <span key={f.param} className="inline-flex h-7 items-center rounded-[8px] border border-line bg-surface text-[12.5px]" data-testid="filter-pill">
                <Menu
                  label={`Filter by ${f.label.toLowerCase()}`}
                  title={f.label}
                  options={f.options}
                  value={vs}
                  multiple={!f.single}
                  searchable={f.options.length > 6}
                  autoOpen={pendingField === f.param && vs.length === 0}
                  onClose={() => setPendingField(null)}
                  onSelect={(v) => toggleValue(f, v)}
                  trigger={(p) => (
                    <button type="button" {...p} ref={p.ref as (el: HTMLButtonElement | null) => void} className="inline-flex h-full items-center gap-1 rounded-l-[8px] px-2 hover:bg-sunk focus-visible:outline-2 focus-visible:outline-accent">
                      {f.icon}
                      <span className="text-muted">{f.label}</span>
                      <span className="text-muted">{vs.length > 1 ? "is any of" : "is"}</span>
                      <span className="max-w-[220px] truncate font-medium">{names.join(", ") || "…"}</span>
                    </button>
                  )}
                />
                <button
                  type="button"
                  className="inline-flex h-full items-center rounded-r-[8px] border-l border-line px-1.5 text-muted hover:bg-sunk hover:text-ink"
                  aria-label={`Remove filter ${f.label}`}
                  onClick={() => {
                    setPendingField(null);
                    go({ [f.param]: null }, true);
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            );
          })}
          {hasFilters && (
            <Link href={href(Object.fromEntries([...filterParams, "view"].map((k) => [k, null])))} scroll={false} className="px-1 text-[12px] text-muted hover:text-ink">
              Clear
            </Link>
          )}
          <span className="ml-auto flex min-w-0 max-w-full items-center gap-1.5 overflow-x-auto" role="group" aria-label="My filters">
            <span className="eyebrow shrink-0">My filters</span>
            {saved.map((s) => (
              <span key={s.name} className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full border pl-2.5 pr-1 text-[12px] ${s.qs === currentQs && currentQs ? "border-accent bg-accent-soft text-ink" : "border-line text-muted"}`}>
                <Link href={s.qs ? `${path}?${s.qs}` : path} scroll={false} className="hover:underline">
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
                  className="input h-7 w-[170px] py-0 text-[12px]"
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
              <button type="button" className="inline-flex h-7 shrink-0 items-center rounded-full border border-dashed border-line px-2.5 text-[12px] text-muted hover:text-ink" onClick={() => setNaming(summary())}>
                + Save current
              </button>
            ) : (
              saved.length === 0 && <span className="whitespace-nowrap text-[12px] text-muted">Set filters, then save them here.</span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function FilterGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

/** Display: grouping, ordering and which properties the rows show (in the URL, defaults omitted). */
function DisplayButton({ display, query, go }: { display: DisplayConfig; query: Record<string, string | undefined>; go: (c: Record<string, string | null>, replace?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const group = query.group ?? display.defaults.group ?? "";
  const order = query.order ?? display.defaults.order ?? "";
  const hidden = query.hide !== undefined ? query.hide.split(",").filter(Boolean) : (display.defaults.hide ?? []);
  const setHidden = (next: string[]) => {
    const same = next.length === (display.defaults.hide ?? []).length && next.every((x) => (display.defaults.hide ?? []).includes(x));
    go({ hide: same ? null : next.join(",") || "none" }, true);
  };
  return (
    <div className="relative" ref={box}>
      <button type="button" className="btn btn-sm gap-1.5" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <Icon name="settings" size={14} /> Display
      </button>
      {open && (
        <div role="dialog" aria-label="Display options" className="card-raised absolute right-0 top-full z-40 mt-1 w-[min(300px,calc(100vw-24px))] space-y-3 p-3 text-[13px]">
          {display.groupings && (
            <label className="flex items-center justify-between gap-3">
              <span className="text-muted">Grouping</span>
              <select className="input h-8 w-[150px] text-[13px]" value={group} onChange={(e) => go({ group: e.target.value === display.defaults.group ? null : e.target.value }, true)}>
                {display.groupings.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {display.orderings && (
            <label className="flex items-center justify-between gap-3">
              <span className="text-muted">Ordering</span>
              <select className="input h-8 w-[150px] text-[13px]" value={order} onChange={(e) => go({ order: e.target.value === display.defaults.order ? null : e.target.value }, true)}>
                {display.orderings.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {display.properties && (
            <div>
              <p className="mb-1.5 text-muted">Properties</p>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Shown properties">
                {display.properties.map((p) => {
                  const on = !hidden.includes(p.value);
                  return (
                    <button
                      key={p.value}
                      type="button"
                      aria-pressed={on}
                      className={`h-7 rounded-[6px] border px-2 text-[12px] ${on ? "border-accent bg-accent-soft text-ink" : "border-line text-muted hover:text-ink"}`}
                      onClick={() => setHidden(on ? [...hidden, p.value] : hidden.filter((x) => x !== p.value))}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <button type="button" className="text-[12px] text-muted hover:text-ink" onClick={() => go({ group: null, order: null, hide: null }, true)}>
            Reset to default
          </button>
        </div>
      )}
    </div>
  );
}
