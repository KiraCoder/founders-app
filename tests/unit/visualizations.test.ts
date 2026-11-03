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

  describe("edge data (merge review)", () => {
    it("BarChart: negative bars hang below the zero line, zero differs from no data, empty is labelled", () => {
      const html = renderToStaticMarkup(
        createElement(BarChart, {
          data: [
            { label: "A", value: 100 },
            { label: "B", value: -50, formatted: "−50 сом" },
            { label: "C", value: 0 },
            { label: "D", value: null },
            { label: "E", value: Number.NaN },
          ],
          height: 78,
          showLabels: true,
        }),
      );
      // height 78 - 18 labels = 60; plot 3..60 (57px); span 150 → zero line at 3 + 100/150*57 = 41.
      expect(html).toContain('y1="41"');
      expect(html).toMatch(/<rect x="26" y="41"/); // the negative bar starts at the zero line
      expect(html.match(/stroke-dasharray="2 2"/g)).toHaveLength(2); // null and NaN
      expect(html).toContain("B −50 сом");
      expect(html).toContain("D no data");
      expect(renderToStaticMarkup(createElement(BarChart, { data: [] }))).toContain('aria-label="Bar chart: no data"');
    });

    it("DonutBreakdown: zero / negative slices take 0% and the label carries the breakdown", () => {
      const html = renderToStaticMarkup(
        createElement(DonutBreakdown, {
          slices: [
            { label: "Paid", value: 3 },
            { label: "Refunds", value: -2 },
            { label: "Empty", value: 0 },
          ],
          centerLabel: "Orders",
        }),
      );
      expect(html).toContain("(100%)");
      expect(html).not.toContain("-67%");
      expect(html).toContain('aria-label="Orders: Paid 3 (100%), Refunds -2 (0%), Empty 0 (0%)"');
    });

    it("ProgressMetric: zero target or negative current → empty bar, no bogus gap; bar has a name", () => {
      const zero = renderToStaticMarkup(createElement(ProgressMetric, { current: 5, target: 0, label: "X" }));
      expect(zero).toContain("width:0%");
      expect(zero).not.toContain("to target");
      const neg = renderToStaticMarkup(createElement(ProgressMetric, { current: -20, target: 100, label: "Profit" }));
      expect(neg).toContain("width:0%");
      expect(neg).toContain('aria-label="Profit"');
    });
  });
});
