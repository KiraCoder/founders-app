"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/Icon";
import { isActivePath } from "./NavLink";

const TABS: { href: string; label: string; icon: IconName; match: string[] }[] = [
  { href: "/", label: "Today", icon: "today", match: ["/"] },
  { href: "/tasks", label: "Tasks", icon: "tasks", match: ["/tasks", "/projects"] },
  { href: "/companies", label: "Companies", icon: "building", match: ["/companies"] },
  { href: "/more", label: "More", icon: "more", match: ["/more", "/holding", "/people", "/org", "/ai-roles", "/search", "/settings", "/dev"] },
];

export function BottomTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Tabs"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-surface/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {TABS.map((t) => {
        const active = t.match.some((m) => isActivePath(pathname, m));
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`relative flex flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${
              active ? "font-semibold text-accent" : "font-medium text-muted hover:text-ink"
            }`}
          >
            <Icon name={t.icon} size={20} />
            {t.label}
            {active && (
              <span
                className="absolute top-1 size-1 rounded-full bg-accent"
                aria-hidden="true"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
