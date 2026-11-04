import { describe, expect, it } from "vitest";
import {
  accentStyle,
  BRAND_METRIC_KEYS,
  dashboardTemplateFor,
  FACTORY_METRIC_KEYS,
  groupByUnit,
  JOURNEY_EDIT_HREF,
  pickMetricCards,
  TEMPLATE_ACCENT_TOKEN,
  templateConnectorId,
  templateMetricKeys,
  type DashboardTemplate,
} from "@/components/company-dashboards/templates";
import { COMPANY_KINDS } from "@/server/db/schema";

describe("kind → dashboard template", () => {
  it("maps every company kind", () => {
    const map = Object.fromEntries(COMPANY_KINDS.map((k) => [k, dashboardTemplateFor(k)]));
    expect(map).toEqual({
      it_services: "it_services",
      factory: "factory",
      brand_sales: "brand_sales",
      sales_partners: "sales_partners",
      courier: "default",
      generic: "default",
    });
  });

  it("falls back to the standard overview for unknown or missing kinds", () => {
    expect(dashboardTemplateFor(undefined)).toBe("default");
    expect(dashboardTemplateFor(null)).toBe("default");
    expect(dashboardTemplateFor("")).toBe("default");
    expect(dashboardTemplateFor("toString")).toBe("default");
    expect(dashboardTemplateFor("IT_SERVICES")).toBe("default");
  });

  it("gives each kind template its own accent token", () => {
    const kinds: DashboardTemplate[] = ["it_services", "factory", "brand_sales", "sales_partners"];
    expect(new Set(kinds.map((k) => TEMPLATE_ACCENT_TOKEN[k])).size).toBe(kinds.length);
    expect(accentStyle("it_services")).toEqual({ "--kind-accent": "var(--info)", "--kind-accent-soft": "var(--info-soft)" });
    expect(accentStyle("default")).toEqual({ "--kind-accent": "var(--accent)", "--kind-accent-soft": "var(--accent-soft)" });
  });

  it("knows the metric keys and data source each template shows", () => {
    expect(templateMetricKeys("factory")).toEqual(["orders_open", "units_in_progress", "output_pcs", "defects_pct"]);
    expect(templateMetricKeys("brand_sales")).toEqual(["wb_orders", "wb_sales_amount", "wb_returns"]);
    expect(templateMetricKeys("it_services")).toEqual([]);
    expect(templateConnectorId("factory")).toBe("alura-erp");
    expect(templateConnectorId("brand_sales")).toBe("wb-sales");
    expect(templateConnectorId("default")).toBeNull();
    expect(JOURNEY_EDIT_HREF("upsell-group")).toBe("/org?company=upsell-group");
  });
});

describe("metric card picking", () => {
  const card = (key: string, unitName: string | null) => ({ key, unitName, id: `${key}:${unitName}` });

  it("keeps only the template's keys, in key order, company-wide first", () => {
    const cards = [card("revenue", null), card("output_pcs", "ХБК"), card("defects_pct", "Ош Район"), card("output_pcs", null), card("orders_open", null)];
    expect(pickMetricCards(cards, FACTORY_METRIC_KEYS).map((c) => c.id)).toEqual(["orders_open:null", "output_pcs:null", "output_pcs:ХБК", "defects_pct:Ош Район"]);
    expect(pickMetricCards(cards, BRAND_METRIC_KEYS)).toEqual([]);
  });

  it("groups by unit with company-wide first", () => {
    const cards = [card("output_pcs", "ХБК"), card("output_pcs", "Ош Район"), card("orders_open", null), card("defects_pct", "ХБК")];
    expect(groupByUnit(cards).map((g) => [g.unitName, g.cards.map((c) => c.key)])).toEqual([
      [null, ["orders_open"]],
      ["ХБК", ["output_pcs", "defects_pct"]],
      ["Ош Район", ["output_pcs"]],
    ]);
  });
});
