import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";
import { PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { logoutAction } from "../actions";

export const metadata = { title: "More" };

const LINKS: { href: string; label: string; icon: IconName }[] = [
  { href: "/holding", label: "Holding", icon: "holding" },
  { href: "/people", label: "People", icon: "people" },
  { href: "/org", label: "Org structure", icon: "org" },
  { href: "/ai-roles", label: "AI roles", icon: "sparkles" },
  { href: "/search", label: "Search", icon: "search" },
];

export default async function MorePage() {
  const ctx = await getPageContext();
  return (
    <>
      <PageHeader eyebrow={ctx.user.email} title="More" />
      <ul className="card mb-4 divide-y divide-line">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="flex items-center gap-3 px-4 py-3 hover:bg-sunk">
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
