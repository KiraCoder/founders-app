"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function isActivePath(pathname: string, href: string, exact = false): boolean {
  const path = href.split("?")[0]!;
  if (exact || path === "/") return pathname === path;
  return pathname === path || pathname.startsWith(`${path}/`);
}

/**
 * A sidebar link. Pass `icon` + `label` for the compact form: when `collapsed`, only the icon shows
 * and the label becomes the accessible name and tooltip. `active` overrides path matching
 * (for links that differ only by query, like company tabs).
 */
export function NavLink({
  href,
  exact,
  children,
  icon,
  label,
  collapsed = false,
  active: activeOverride,
  className = "",
}: {
  href: string;
  exact?: boolean;
  children?: ReactNode;
  icon?: ReactNode;
  label?: string;
  collapsed?: boolean;
  active?: boolean;
  className?: string;
}) {
  const pathname = usePathname() ?? "";
  const active = activeOverride ?? isActivePath(pathname, href, exact);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={`flex min-w-0 items-center gap-2.5 rounded-[8px] py-1.5 text-[13.5px] outline-offset-1 transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-accent ${
        collapsed ? "justify-center px-0" : "px-2.5"
      } ${active ? "bg-accent-soft font-medium text-accent" : "text-ink hover:bg-sunk"} ${className}`}
    >
      {icon}
      {label !== undefined && !collapsed && <span className="truncate">{label}</span>}
      {!collapsed && children}
    </Link>
  );
}
