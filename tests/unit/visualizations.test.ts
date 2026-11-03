import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarChart } from "@/components/metrics/BarChart";
import { DonutBreakdown } from "@/components/metrics/DonutBreakdown";
import { ProgressMetric } from "@/components/metrics/ProgressMetric";

describe("Data Visualizations", () => {
  describe("BarChart", () => {
    it("renders svg bars for numeric values and dashed baselines for null/zero", () => {
      const data = [
        { label: "Mon", value: 120, formatted: "120 orders" },
        { label: "Tue", value: null },
        { label: "Wed", value: 250, tone: "ok" as const },
      ];
      const html = renderToStaticMarkup(createElement(BarChart, { data }));
      expect(html).toContain("<svg");
      expect(html).toContain("<rect");
      expect(html).toContain("stroke-dasharray=\"2 2\"");
      expect(html).toContain("Mon");
      expect(html).toContain("Wed");
    });
  });

  describe("ProgressMetric", () => {
    it("renders percentage and progress bar fill according to target", () => {
      const html = renderToStaticMarkup(
        createElement(ProgressMetric, {
          current: 750,
          target: 1000,
          label: "Monthly Deliveries",
          unit: "orders",
        })
      );
      expect(html).toContain("75%");
      expect(html).toContain("Monthly Deliveries");
      expect(html).toContain("width:75%");
      // The gap carries the unit, like the "(750 orders / 1,000 orders)" line above it.
      expect(html).toContain("250 orders to target");
    });

    it("handles 100% completion with ok tone", () => {
      const html = renderToStaticMarkup(
        createElement(ProgressMetric, {
          current: 1200,
          target: 1000,
        })
      );
      expect(html).toContain("100%");
      expect(html).toContain("bg-accent");
    });
  });

  describe("DonutBreakdown", () => {
    it("renders svg circle slices with stroke-dasharray and legend", () => {
      const slices = [
        { label: "Done", value: 14, tone: "ok" as const },
        { label: "In Progress", value: 6, tone: "info" as const },
        { label: "Overdue", value: 2, tone: "risk" as const },
      ];
      const html = renderToStaticMarkup(
        createElement(DonutBreakdown, {
          slices,
          centerValue: 22,
          centerLabel: "Total Tasks",
        })
      );
      expect(html).toContain("<svg");
      expect(html).toContain("22");
      // Upper case is CSS (`uppercase`), the DOM text stays as given.
      expect(html).toContain("Total Tasks");
      expect(html).toContain("uppercase");
      expect(html).toContain("Done");
      expect(html).toContain("Overdue");
      expect(html).toContain("(64%)");
    });
  });
});
