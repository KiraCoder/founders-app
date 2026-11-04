/**
 * Company dashboard templates: which overview a company gets, picked by `companies.kind`
 * (migration 0027). Pure, no imports from the server: used by the page and by unit tests.
 */
import type { CSSProperties } from "react";

export type DashboardTemplate = "it_services" | "factory" | "brand_sales" | "sales_partners" | "default";

const TEMPLATE_BY_KIND: Record<string, DashboardTemplate> = {
  it_services: "it_services",
  factory: "factory",
  brand_sales: "brand_sales",
  sales_partners: "sales_partners",
  // courier / generic (and anything unknown) keep the standard overview.
  courier: "default",
  generic: "default",
};

export function dashboardTemplateFor(kind: string | null | undefined): DashboardTemplate {
  return kind && Object.hasOwn(TEMPLATE_BY_KIND, kind) ? TEMPLATE_BY_KIND[kind]! : "default";
}

/** Theme token each template uses as its accent (tokens from globals.css; light + dark). */
export const TEMPLATE_ACCENT_TOKEN: Record<DashboardTemplate, "accent" | "info" | "warn" | "risk"> = {
  it_services: "info",
  factory: "warn",
  brand_sales: "risk",
  sales_partners: "accent",
  default: "accent",
};

/**
 * Inline style that sets `--kind-accent` / `--kind-accent-soft` to the template's token. Only
 * decorative parts (stripes, column headers, step numbers) use it; status colors (ok / warn /
 * risk, sparklines, good / bad changes) keep their meaning.
 */
export function accentStyle(t: DashboardTemplate): CSSProperties {
  const token = TEMPLATE_ACCENT_TOKEN[t];
  return { "--kind-accent": `var(--${token})`, "--kind-accent-soft": `var(--${token}-soft)` } as CSSProperties;
}

export const TEMPLATE_TITLES: Record<DashboardTemplate, string> = {
  it_services: "Client projects",
  factory: "Production",
  brand_sales: "Wildberries sales",
  sales_partners: "Partner journey",
  default: "Overview",
};

/** Metric keys shown by the production panel (Alura Style), fed by the "alura-erp" connector. */
export const FACTORY_CONNECTOR_ID = "alura-erp";
export const FACTORY_METRIC_KEYS = ["orders_open", "units_in_progress", "output_pcs", "defects_pct"] as const;

/** Metric keys shown by the WB sales panel (Alura Brand), fed by the "wb-sales" connector. */
export const BRAND_CONNECTOR_ID = "wb-sales";
export const BRAND_METRIC_KEYS = ["wb_orders", "wb_sales_amount", "wb_returns"] as const;

/** Metric keys a template already shows (left out of the generic "Key numbers"). */
export function templateMetricKeys(t: DashboardTemplate): readonly string[] {
  if (t === "factory") return FACTORY_METRIC_KEYS;
  if (t === "brand_sales") return BRAND_METRIC_KEYS;
  return [];
}

/** The data source a template shows its own status card for. */
export function templateConnectorId(t: DashboardTemplate): string | null {
  if (t === "factory") return FACTORY_CONNECTOR_ID;
  if (t === "brand_sales") return BRAND_CONNECTOR_ID;
  return null;
}

/** Org page link where the journey strip is edited. */
export const JOURNEY_EDIT_HREF = (slug: string) => `/org?company=${encodeURIComponent(slug)}`;

/**
 * Cards of the given keys, in key order; within a key, company-wide first, then units in
 * their order. Cards of other keys are left out.
 */
export function pickMetricCards<T extends { key: string; unitName: string | null }>(cards: readonly T[], keys: readonly string[]): T[] {
  const order = new Map(keys.map((k, i) => [k, i]));
  return cards
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => order.has(c.key))
    .sort((a, b) => order.get(a.c.key)! - order.get(b.c.key)! || (a.c.unitName === null ? -1 : 0) - (b.c.unitName === null ? -1 : 0) || a.i - b.i)
    .map(({ c }) => c);
}

/** Groups cards by unit ("ХБК", "Ош Район"; company-wide = null first), keeping card order. */
export function groupByUnit<T extends { unitName: string | null }>(cards: readonly T[]): { unitName: string | null; cards: T[] }[] {
  const groups: { unitName: string | null; cards: T[] }[] = [];
  for (const c of cards) {
    let g = groups.find((x) => x.unitName === c.unitName);
    if (!g) groups.push((g = { unitName: c.unitName, cards: [] }));
    g.cards.push(c);
  }
  return groups.sort((a, b) => (a.unitName === null ? -1 : 0) - (b.unitName === null ? -1 : 0));
}
