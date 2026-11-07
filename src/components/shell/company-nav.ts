import type { IconName } from "@/components/Icon";

/** Cookie that remembers the last company you worked in, for when you're on a global page. */
export const COMPANY_COOKIE = "fc-company";
/** localStorage key for the collapsed (icon-only) sidebar. */
export const SIDEBAR_COLLAPSED_KEY = "fc-sidebar-collapsed";

export interface NavCompany {
  slug: string;
  name: string;
  color: string;
  status: string;
}

/** The company slug in a `/companies/<slug>/...` path, or null on any other page. */
export function companySlugFromPath(pathname: string | null | undefined): string | null {
  const m = /^\/companies\/([^/?#]+)/.exec(pathname ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * The company the sidebar is scoped to: the one in the URL when it is a known company,
 * otherwise the remembered one from the cookie (when it is still a known company), otherwise none.
 */
export function currentCompanySlug(
  pathname: string | null | undefined,
  cookieSlug: string | null | undefined,
  companies: readonly Pick<NavCompany, "slug">[],
): string | null {
  const known = (s: string | null | undefined): s is string => !!s && companies.some((c) => c.slug === s);
  const fromPath = companySlugFromPath(pathname);
  if (known(fromPath)) return fromPath;
  if (known(cookieSlug)) return cookieSlug;
  return null;
}

/** Reads one cookie's value out of a `document.cookie`-style string. */
export function readCookie(cookieString: string | null | undefined, name: string): string | null {
  for (const part of (cookieString ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** A `document.cookie` assignment that remembers (or, with null, forgets) the current company. */
export function companyCookie(slug: string | null): string {
  const base = `${COMPANY_COOKIE}=${slug ? encodeURIComponent(slug) : ""}; Path=/; SameSite=Lax`;
  return slug ? `${base}; Max-Age=${60 * 60 * 24 * 365}` : `${base}; Max-Age=0`;
}

export type CompanySectionKey = "overview" | "tasks" | "projects" | "people" | "org" | "numbers" | "ai";

export interface CompanySection {
  key: CompanySectionKey;
  label: string;
  icon: IconName;
  href: string;
}

const SECTIONS: { key: CompanySectionKey; label: string; icon: IconName }[] = [
  { key: "overview", label: "Overview", icon: "building" },
  { key: "tasks", label: "Tasks", icon: "tasks" },
  { key: "projects", label: "Projects", icon: "folder" },
  { key: "people", label: "People", icon: "people" },
  { key: "org", label: "Org", icon: "org" },
  { key: "numbers", label: "Numbers", icon: "holding" },
  { key: "ai", label: "AI roles", icon: "sparkles" },
];

/** Links to a company's tabs on `/companies/[slug]` (Overview has no `?tab=`). */
export function companySections(slug: string): CompanySection[] {
  const base = `/companies/${encodeURIComponent(slug)}`;
  return SECTIONS.map((s) => ({ ...s, href: s.key === "overview" ? base : `${base}?tab=${s.key}` }));
}

/** Which company section the current URL shows, or null when it isn't on that company's page. */
export function activeCompanySection(pathname: string, tab: string | null | undefined, slug: string): CompanySectionKey | null {
  if (companySlugFromPath(pathname) !== slug) return null;
  const rest = pathname.slice(`/companies/`.length).split("/").slice(1).filter(Boolean);
  if (rest[0] === "numbers") return "numbers";
  if (rest.length) return null;
  const match = SECTIONS.find((s) => s.key === tab);
  return match ? match.key : "overview";
}

/** Parses the stored collapsed flag; anything unexpected means expanded. */
export function parseCollapsed(raw: string | null | undefined): boolean {
  return raw === "1";
}
