"use client";

import { Suspense, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon, type IconName } from "@/components/Icon";
import { NavLink } from "./NavLink";
import { CompanySwitcher, useCurrentCompany } from "./CompanySwitcher";
import { SIDEBAR_COLLAPSED_KEY, activeCompanySection, companySections, parseCollapsed, type NavCompany } from "./company-nav";

// ---- collapsed flag: localStorage-backed, SSR renders expanded ----------------------------------
const COLLAPSE_EVENT = "fc-sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return parseCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY));
  } catch {
    return false;
  }
}

function subscribeCollapsed(cb: () => void): () => void {
  window.addEventListener("storage", cb);
  window.addEventListener(COLLAPSE_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(COLLAPSE_EVENT, cb);
  };
}

function setCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // Storage blocked: the toggle just won't be remembered.
  }
  window.dispatchEvent(new Event(COLLAPSE_EVENT));
}

// ---- pieces ----------------------------------------------------------------------------------------
function Group({ title, collapsed, children }: { title: string; collapsed: boolean; children: React.ReactNode }) {
  return (
    <div className="mb-3" role="group" aria-label={title}>
      {collapsed ? (
        <div className="mx-2 mb-1.5 h-px bg-line" aria-hidden="true" />
      ) : (
        <p className="eyebrow mb-1 truncate px-2.5" aria-hidden="true">
          {title}
        </p>
      )}
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function CompanySectionLinks({ slug, tab, collapsed }: { slug: string; tab: string | null; collapsed: boolean }) {
  const pathname = usePathname() ?? "";
  const active = activeCompanySection(pathname, tab, slug);
  return (
    <>
      {companySections(slug).map((s) => (
        <NavLink
          key={s.key}
          href={s.href}
          active={active === s.key}
          collapsed={collapsed}
          label={s.label}
          icon={<Icon name={s.icon} size={collapsed ? 18 : 16} />}
        />
      ))}
    </>
  );
}

function CompanySectionLinksWithTab(props: { slug: string; collapsed: boolean }) {
  const tab = useSearchParams().get("tab");
  return <CompanySectionLinks {...props} tab={tab} />;
}

const GLOBAL: { href: string; label: string; icon: IconName; exact?: boolean }[] = [
  { href: "/", label: "Today", icon: "today", exact: true },
  { href: "/tasks", label: "Tasks", icon: "tasks" },
  { href: "/people", label: "People", icon: "people" },
  { href: "/search", label: "Search", icon: "search" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

const GROUP: { href: string; label: string; icon: IconName }[] = [
  { href: "/holding", label: "Holding", icon: "holding" },
  { href: "/org", label: "Org structure", icon: "org" },
  { href: "/ai-roles", label: "AI roles", icon: "sparkles" },
];

export function Sidebar({
  companies,
  initialCompany = null,
  showDevTools = false,
}: {
  companies: NavCompany[];
  /** The `fc-company` cookie as the server read it. */
  initialCompany?: string | null;
  showDevTools?: boolean;
}) {
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const { company, forget } = useCurrentCompany(companies, initialCompany);
  const iconSize = collapsed ? 18 : 16;
  const groupItems = showDevTools ? [...GROUP, { href: "/dev/notifications", label: "Dev inbox", icon: "bell" as const }] : GROUP;

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      className={`sticky top-0 z-30 hidden h-dvh shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150 md:flex ${
        collapsed ? "w-[60px]" : "w-[216px]"
      }`}
    >
      <Link
        href="/"
        aria-label="Founder Cockpit — Today"
        title={collapsed ? "Founder Cockpit" : undefined}
        className={`flex h-14 shrink-0 items-center gap-2.5 border-b border-line outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-accent ${
          collapsed ? "justify-center px-0" : "px-4"
        }`}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-accent text-[13px] font-bold text-accent-ink">F</span>
        {!collapsed && <span className="truncate text-[15px] font-semibold">Founder Cockpit</span>}
      </Link>

      <div className="shrink-0 px-2 pt-3">
        <CompanySwitcher companies={companies} current={company} onForget={forget} collapsed={collapsed} />
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3" aria-label="Main">
        {company && (
          <Group title={company.name} collapsed={collapsed}>
            <Suspense fallback={<CompanySectionLinks slug={company.slug} tab={null} collapsed={collapsed} />}>
              <CompanySectionLinksWithTab slug={company.slug} collapsed={collapsed} />
            </Suspense>
          </Group>
        )}
        <Group title="Workspace" collapsed={collapsed}>
          {GLOBAL.map((l) => (
            <NavLink key={l.href} href={l.href} exact={l.exact} collapsed={collapsed} label={l.label} icon={<Icon name={l.icon} size={iconSize} />} />
          ))}
        </Group>
        <Group title="Group" collapsed={collapsed}>
          {groupItems.map((l) => (
            <NavLink key={l.href} href={l.href} collapsed={collapsed} label={l.label} icon={<Icon name={l.icon} size={iconSize} />} />
          ))}
        </Group>
      </nav>

      <div className={`flex shrink-0 items-center border-t border-line py-2 text-[11px] text-muted ${collapsed ? "justify-center px-0" : "justify-between pl-4 pr-2"}`}>
        {!collapsed && <span className="truncate">Asqa Zou group</span>}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="grid size-8 place-items-center rounded-[8px] text-muted outline-offset-1 hover:bg-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 4.5h16v15H4zM9.5 4.5v15" />
            <path d={collapsed ? "M13.5 10l2 2-2 2" : "M16 10l-2 2 2 2"} />
          </svg>
        </button>
      </div>
    </aside>
  );
}
