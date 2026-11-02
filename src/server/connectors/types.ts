/**
 * Connector layer: a source of numbers (Kiwi Go app, WMS, Alura ERP, Wildberries).
 * Each source is plugged in by implementing `Connector` and adding it to the registry
 * (registry.ts). The runner (runner.ts) writes what `pull` returns as metric values with
 * source = connector and logs every attempt in `connector_runs`.
 *
 * No "server-only" and no side effects, so tests can implement fake connectors.
 */
import type { IsoDate } from "@/lib/dates";

export interface DateRange {
  from: IsoDate;
  to: IsoDate;
}

/** One number for one metric and day/period. `periodStart` may be any day in the period. */
export interface MetricPoint {
  /** Metric key in the connector's company (src/lib/kpis.ts), e.g. "orders_day". */
  metricKey: string;
  /** Company unit slug for factory metrics (e.g. "hbk"). */
  unitSlug?: string | null;
  periodStart: IsoDate;
  value: number;
}

export type ConnectorHealthState = "ok" | "not_configured" | "error";

export interface ConnectorHealth {
  state: ConnectorHealthState;
  /** Short human status, e.g. "Waiting for API access from Edil", "Needs WB token". */
  message: string;
  /** Environment variables this connector needs (names only, never values). */
  envVars: string[];
  /** Which of those are not set. */
  missingEnv: string[];
}

export interface Connector {
  id: string;
  /** English display name. */
  name: string;
  companySlug: string;
  /** Metric keys it can provide (optionally per unit). */
  metrics: { key: string; unitSlug?: string | null }[];
  healthCheck(): Promise<ConnectorHealth>;
  /** Only called when healthCheck() is ok. */
  pull(range: DateRange): Promise<MetricPoint[]>;
}
