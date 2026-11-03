"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function isActivePath(pathname: string, href: string, exact = false): boolean {
  const path = href.split("?")[0]!;
  if (exact || path === "/") return pathname === path;
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function NavLink({
  href,
  exact,
  children,
  className = "",
}: {
  href: string;
  exact?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const active = isActivePath(pathname, href, exact);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-[13.5px] transition-colors duration-100 ${
        active ? "bg-accent-soft font-medium text-accent" : "text-ink hover:bg-sunk"
      } ${className}`}
    >
      {children}
    </Link>
  );
}
