/**
 * Placeholder key numbers per company. Real values arrive with the connector layer
 * (ERP, WMS, Kiwi Go app, Wildberries). Until then every card shows "no data yet".
 */
export interface KpiDef {
  key: string;
  label: string;
  source: string;
  /** Optional company unit slug (e.g. Alura Style factories). */
  unit?: string;
}

const DEFAULT: KpiDef[] = [
  { key: "revenue_month", label: "Revenue this month", source: "Manual entry" },
  { key: "expenses_month", label: "Expenses this month", source: "Manual entry" },
  { key: "headcount", label: "Headcount", source: "People" },
];

export const KPIS: Record<string, KpiDef[]> = {
  "kiwi-go": [
    { key: "orders_day", label: "Orders per day", source: "Kiwi Go app" },
    { key: "cod_collected", label: "COD collected", source: "Kiwi Go app" },
    { key: "cod_paid_out", label: "COD paid out", source: "Kiwi Go app" },
    { key: "couriers_active", label: "Active couriers", source: "Kiwi Go app" },
  ],
  jobutify: [
    { key: "projects_active", label: "Client projects", source: "Manual entry" },
    { key: "revenue_month", label: "Revenue this month", source: "Manual entry" },
    { key: "headcount", label: "Headcount", source: "People" },
  ],
  "alura-brand": [
    { key: "orders_to_factory", label: "Orders to factory", source: "ERP" },
    { key: "stock", label: "Stock on hand", source: "WMS" },
    { key: "revenue_month", label: "Revenue this month", source: "Manual entry" },
  ],
  "alura-style": [
    { key: "output_day", label: "Output per day", source: "ERP", unit: "hbk" },
    { key: "output_day", label: "Output per day", source: "ERP", unit: "osh-rayon" },
    { key: "defects", label: "Defect rate", source: "ERP" },
    { key: "piecework", label: "Piecework pay total", source: "ERP" },
  ],
  "upsell-group": [
    { key: "wb_orders", label: "Wildberries orders", source: "Wildberries API" },
    { key: "wb_revenue", label: "Marketplace revenue", source: "Wildberries API" },
    { key: "returns", label: "Returns", source: "WMS" },
  ],
  "asqa-zou-holding": [
    { key: "acts_missing", label: "Missing monthly акты", source: "Accountant" },
    { key: "intercompany_debt", label: "Intercompany debts", source: "Accountant" },
  ],
};

export function kpisFor(slug: string): KpiDef[] {
  return KPIS[slug] ?? DEFAULT;
}
