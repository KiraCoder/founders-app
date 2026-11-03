import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";
import { InitialsAvatar, PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { devToolsEnabled } from "@/server/notifications/config";
import { logoutAction } from "../actions";

export const metadata = { title: "More" };

const LINKS: { href: string; label: string; icon: IconName }[] = [
  { href: "/holding", label: "Holding", icon: "holding" },
  { href: "/people", label: "People", icon: "people" },
  { href: "/org", label: "Org structure", icon: "org" },
  { href: "/ai-roles", label: "AI roles", icon: "sparkles" },
  { href: "/search", label: "Search", icon: "search" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

export default async function MorePage() {
  const ctx = await getPageContext();
  return (
    <>
      <PageHeader eyebrow="Menu & Navigation" title="More" />

      {/* User profile card */}
      <div className="card mb-4 flex items-center gap-3 p-3.5">
        <InitialsAvatar name={ctx.user.name} size={40} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink leading-tight">{ctx.user.name}</p>
          <p className="truncate text-[12px] text-muted">{ctx.user.email}</p>
        </div>
      </div>

      <ul className="card mb-4 divide-y divide-line">
        {[...LINKS, ...(devToolsEnabled() ? [{ href: "/dev/notifications", label: "Dev inbox", icon: "bell" as const }] : [])].map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="flex items-center gap-3 px-4 py-3 text-[14px] font-medium hover:bg-sunk">
              <Icon name={l.icon} /> {l.label}
            </Link>
          </li>
        ))}
      </ul>
      <form action={logoutAction}>
        <button type="submit" className="btn w-full">
          <Icon name="logout" size={16} /> Sign out ({ctx.user.shortName})
        </button>
      </form>
    </>
  );
}
