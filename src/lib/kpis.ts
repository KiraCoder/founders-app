/**
 * Default key numbers per company. `npm run db:seed` copies these into the
 * `metric_definitions` table (only missing ones; edits made later in the DB are kept),
 * which is the source of truth from then on. Values arrive by manual entry, upload or a
 * connector (src/server/connectors).
 *
 * Pure data, no imports from the server.
 */
export const METRIC_UNITS = ["KGS", "pcs", "orders", "%", "people", "count"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export interface MetricSeed {
  key: string;
  /** English UI name. */
  name: string;
  /** Other accepted upload headers (Russian, short forms). */
  aliases: string[];
  unit: MetricUnit;
  granularity: "day" | "week" | "month";
  /**
   * How a connector's finer points (days) become one week/month value. Default: "avg" for
   * percentages, "last" for people counts, otherwise "sum" (see `seedAggregation`).
   */
  aggregation?: "sum" | "avg" | "last";
  direction: "higher_is_better" | "lower_is_better" | "neutral";
  sourceKind: "manual" | "upload" | "connector";
  connectorId?: string;
  target?: number;
  /** Company unit slug (e.g. Alura Style factories); one definition per unit. */
  units?: string[];
}

export const METRIC_SEED: Record<string, MetricSeed[]> = {
  "kiwi-go": [
    { key: "orders_day", name: "Orders per day", aliases: ["Заказы в день", "Заказы", "Orders"], unit: "orders", granularity: "day", direction: "higher_is_better", sourceKind: "connector", connectorId: "kiwigo-app" },
    { key: "on_time_pct", name: "On-time delivery", aliases: ["Доставлено вовремя", "Вовремя %", "On-time %", "On time"], unit: "%", granularity: "day", direction: "higher_is_better", sourceKind: "connector", connectorId: "kiwigo-app", target: 95 },
    { key: "cod_collected", name: "COD collected", aliases: ["НП собрано", "Наложенный платёж собран", "COD собрано"], unit: "KGS", granularity: "day", direction: "higher_is_better", sourceKind: "connector", connectorId: "kiwigo-app" },
    { key: "cod_paid_out", name: "COD paid out", aliases: ["НП выплачено", "COD выплачено", "Выплачено магазинам"], unit: "KGS", granularity: "day", direction: "neutral", sourceKind: "connector", connectorId: "kiwigo-app" },
    { key: "revenue", name: "Revenue", aliases: ["Выручка", "Доход", "Revenue month"], unit: "KGS", granularity: "month", direction: "higher_is_better", sourceKind: "manual" },
    { key: "couriers_active", name: "Active couriers", aliases: ["Активные курьеры", "Курьеры", "Couriers"], unit: "people", granularity: "day", direction: "higher_is_better", sourceKind: "connector", connectorId: "kiwigo-app" },
  ],
  jobutify: [
    { key: "wms_orders_day", name: "WMS orders processed", aliases: ["Обработано заказов", "Заказы WMS", "Orders processed"], unit: "orders", granularity: "day", direction: "higher_is_better", sourceKind: "connector", connectorId: "wms-jobutify" },
    { key: "wms_shipment_errors", name: "Shipment errors", aliases: ["Ошибки отгрузки", "Ошибки", "Errors"], unit: "count", granularity: "day", direction: "lower_is_better", sourceKind: "connector", connectorId: "wms-jobutify" },
  ],
  "alura-brand": [
    { key: "orders_to_factory", name: "Orders to factory", aliases: ["Заказы на фабрику", "Заказ фабрике"], unit: "pcs", granularity: "month", direction: "higher_is_better", sourceKind: "upload" },
    { key: "sales", name: "Sales", aliases: ["Продажи", "Выручка"], unit: "KGS", granularity: "month", direction: "higher_is_better", sourceKind: "manual" },
  ],
  "alura-style": [
    { key: "output_pcs", name: "Output per day", aliases: ["Выпуск", "Выпуск шт", "Пошив", "Output"], unit: "pcs", granularity: "day", direction: "higher_is_better", sourceKind: "connector", connectorId: "alura-erp", units: ["hbk", "osh-rayon"] },
    { key: "defect_pct", name: "Defect rate", aliases: ["Брак %", "Брак", "Defects"], unit: "%", granularity: "week", direction: "lower_is_better", sourceKind: "connector", connectorId: "alura-erp", target: 2, units: ["hbk", "osh-rayon"] },
    { key: "headcount", name: "Headcount", aliases: ["Численность", "Сотрудники", "Люди"], unit: "people", granularity: "month", direction: "neutral", sourceKind: "connector", connectorId: "alura-erp", units: ["hbk", "osh-rayon"] },
    { key: "piecework_total", name: "Piecework pay total", aliases: ["Сдельная оплата", "Сдельная оплата итого", "ФОТ сдельный", "Piecework"], unit: "KGS", granularity: "month", direction: "neutral", sourceKind: "connector", connectorId: "alura-erp", units: ["hbk", "osh-rayon"] },
  ],
  "upsell-group": [
    { key: "wb_sales", name: "Wildberries sales", aliases: ["Продажи WB", "Продажи Wildberries", "Продажи", "WB sales"], unit: "KGS", granularity: "day", direction: "higher_is_better", sourceKind: "connector", connectorId: "wildberries" },
    { key: "wb_orders", name: "Wildberries orders", aliases: ["Заказы WB", "Заказы Wildberries", "Заказы", "WB orders"], unit: "orders", granularity: "day", direction: "higher_is_better", sourceKind: "connector", connectorId: "wildberries" },
    { key: "wb_returns", name: "Returns", aliases: ["Возвраты", "Возвраты WB", "WB returns"], unit: "pcs", granularity: "day", direction: "lower_is_better", sourceKind: "connector", connectorId: "wildberries" },
  ],
  "asqa-zou-holding": [
    { key: "intercompany_debt", name: "Intercompany debt total", aliases: ["Долги между компаниями", "Взаимные долги", "Intercompany debt"], unit: "KGS", granularity: "month", aggregation: "last", direction: "lower_is_better", sourceKind: "manual" },
  ],
  // Marketing is planned: no numbers yet.
};

/** Aggregation of a seeded metric: explicit, else avg for %, last for people, else sum. */
export function seedAggregation(d: Pick<MetricSeed, "aggregation" | "unit">): "sum" | "avg" | "last" {
  if (d.aggregation) return d.aggregation;
  if (d.unit === "%") return "avg";
  if (d.unit === "people") return "last";
  return "sum";
}

export function metricSeedFor(slug: string): MetricSeed[] {
  return METRIC_SEED[slug] ?? [];
}
