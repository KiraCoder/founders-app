"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/Icon";
import { CompanyDot } from "@/components/ui";
import { companyCookie, companySlugFromPath, currentCompanySlug, type NavCompany } from "./company-nav";

/**
 * The company the shell is scoped to: from the URL on a company page (and remembered in the
 * `fc-company` cookie), otherwise the remembered one. `initialCookie` is the server-read cookie,
 * so the first render matches the server.
 */
export function useCurrentCompany(companies: readonly NavCompany[], initialCookie: string | null) {
  const pathname = usePathname() ?? "";
  const [remembered, setRemembered] = useState<string | null>(initialCookie);
  const fromPath = companySlugFromPath(pathname);
  const pathIsKnown = !!fromPath && companies.some((c) => c.slug === fromPath);

  // Remember a company when you arrive on its page (only on arrival, so "All companies" can forget it
  // before the navigation away has happened).
  const lastSeen = useRef<string | null>(null);
  useEffect(() => {
    const seen = pathIsKnown ? fromPath : null;
    if (seen === lastSeen.current) return;
    lastSeen.current = seen;
    if (!seen) return;
    setRemembered(seen);
    try {
      document.cookie = companyCookie(seen);
    } catch {
      // Cookies blocked: the switcher still follows the URL.
    }
  }, [pathIsKnown, fromPath]);

  const forget = useCallback(() => {
    setRemembered(null);
    try {
      document.cookie = companyCookie(null);
    } catch {
      // ignore
    }
  }, []);

  const slug = currentCompanySlug(pathname, remembered, companies);
  return { slug, company: companies.find((c) => c.slug === slug) ?? null, forget };
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-muted">
      <path d="M7 10l5-5 5 5M7 14l5 5 5-5" />
    </svg>
  );
}

export function CompanySwitcher({
  companies,
  current,
  onForget,
  collapsed = false,
  className = "",
}: {
  companies: readonly NavCompany[];
  current: NavCompany | null;
  onForget: () => void;
  collapsed?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const pathname = usePathname();

  // Close on navigation.
  useEffect(() => setOpen(false), [pathname]);

  // Close on outside click; focus the current (or first) item when opening.
  useEffect(() => {
    if (!open) return;
    const all = menuItems(menuRef.current);
    (all.find((el) => el.getAttribute("aria-current") === "true") ?? all[0])?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = menuItems(menuRef.current);
    const i = all.indexOf(document.activeElement as HTMLElement);
    const move = (n: number) => {
      e.preventDefault();
      all[(n + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(all.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") close(false);
  };

  const label = current ? current.name : "All companies";
  const itemClass =
    "flex min-w-0 items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-[13.5px] text-ink outline-none hover:bg-sunk focus-visible:bg-sunk focus-visible:outline-2 focus-visible:outline-accent";

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Company: ${label}. Switch company`}
        title={collapsed ? label : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex w-full min-w-0 items-center gap-2 rounded-[8px] border border-line bg-surface text-left text-[13.5px] font-medium text-ink outline-offset-1 transition-colors hover:bg-sunk focus-visible:outline-2 focus-visible:outline-accent ${
          collapsed ? "h-9 justify-center px-0" : "h-9 px-2.5"
        }`}
      >
        <span className="grid size-[18px] shrink-0 place-items-center">
          {current ? <CompanyDot color={current.color} size={10} /> : <Icon name="building" size={16} />}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <Chevron />
          </>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Switch company"
          onKeyDown={onMenuKey}
          className={`absolute z-50 flex max-h-[60dvh] flex-col gap-0.5 overflow-y-auto rounded-[10px] border border-line bg-surface p-1 shadow-card ${
            collapsed ? "left-full top-0 ml-2 w-[240px]" : "inset-x-0 top-full mt-1 min-w-[200px]"
          }`}
        >
          <Link
            href="/companies"
            role="menuitem"
            aria-current={current ? undefined : "true"}
            onClick={() => {
              onForget();
              setOpen(false);
            }}
            className={`${itemClass} ${current ? "" : "font-medium"}`}
          >
            <span className="grid size-[18px] shrink-0 place-items-center">
              <Icon name="building" size={16} />
            </span>
            <span className="truncate">All companies</span>
          </Link>
          {companies.length > 0 && <div role="separator" className="my-0.5 h-px bg-line" />}
          {companies.map((c) => {
            const isCurrent = c.slug === current?.slug;
            return (
              <Link
                key={c.slug}
                href={`/companies/${encodeURIComponent(c.slug)}`}
                role="menuitem"
                aria-current={isCurrent ? "true" : undefined}
                onClick={() => setOpen(false)}
                className={`${itemClass} ${isCurrent ? "bg-accent-soft font-medium text-accent" : ""}`}
              >
                <span className="grid size-[18px] shrink-0 place-items-center">
                  <CompanyDot color={c.color} size={9} />
                </span>
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.status === "planned" && <span className="text-[11px] text-muted">planned</span>}
                {isCurrent && <Icon name="check" size={14} />}
              </Link>
            );
          })}
          <div role="separator" className="my-0.5 h-px bg-line" />
          <Link href="/settings/companies?new=1" role="menuitem" onClick={() => setOpen(false)} className={`${itemClass} text-accent`}>
            <span className="grid size-[18px] shrink-0 place-items-center">
              <Icon name="plus" size={16} />
            </span>
            <span className="truncate">Add company</span>
          </Link>
        </div>
      )}
    </div>
  );
}
