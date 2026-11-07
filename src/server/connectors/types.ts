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
  /**
   * What the value covers: "day" (default), "week" or "month". Daily points for a weekly /
   * monthly metric are combined with the metric's aggregation (sum / avg / last), and only
   * for complete periods whose every day was received.
   */
  granularity?: "day" | "week" | "month";
}

/** Static setup facts, read WITHOUT any network call (shown on every page render). */
export interface ConnectorSetup {
  /** True when this source can run (code built and credentials present). */
  configured: boolean;
  /** Status while not configured, e.g. "Waiting for API access from Edil". */
  message: string;
  /** Very short reason for the morning summary, e.g. "Edil's APIs", "WB token". */
  shortReason: string;
  envVars: string[];
  missingEnv: string[];
}

export interface PullOptions {
  /** Aborted when the run's time limit is reached; connectors pass it to fetch(). */
  signal: AbortSignal;
  /** Page cursor returned by the previous call (undefined for the first page). */
  cursor?: string;
}

/** A page of points; `nextCursor` asks the runner for another page. */
export interface PullPage {
  points: MetricPoint[];
  nextCursor?: string | null;
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
  /** Static status (no network). Pages use this; healthCheck() runs only on "Check now". */
  setup(): ConnectorSetup;
  /** Talks to the source (network). Only from the runner ("Check now", scheduled runs). */
  healthCheck(): Promise<ConnectorHealth>;
  /**
   * Only called when healthCheck() is ok. Must honour `opts.signal`. Returning a page with
   * `nextCursor` makes the runner call again with that cursor (bounded, see runner.ts).
   */
  pull(range: DateRange, opts: PullOptions): Promise<MetricPoint[] | PullPage>;
}
