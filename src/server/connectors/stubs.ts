/**
 * Placeholder connectors for the group's systems. They make NO network calls: until the
 * real API code is written they only report their status. Env var names are documented
 * in .env.example (values empty; Nuraaly adds them in Vercel himself).
 */
import type { Connector, ConnectorHealth, MetricPoint } from "./types";

type Env = Record<string, string | undefined>;

interface StubSpec {
  id: string;
  name: string;
  companySlug: string;
  envVars: string[];
  /** Status shown while the env vars are missing. */
  waitingMessage: string;
  metrics: Connector["metrics"];
}

const UNITS = ["hbk", "osh-rayon"];

export const STUB_SPECS: StubSpec[] = [
  {
    id: "kiwigo-app",
    name: "Kiwi Go app",
    companySlug: "kiwi-go",
    envVars: ["KIWIGO_API_URL", "KIWIGO_API_TOKEN"],
    waitingMessage: "Waiting for API access from Edil",
    metrics: ["orders_day", "on_time_pct", "cod_collected", "cod_paid_out", "couriers_active"].map((key) => ({ key })),
  },
  {
    id: "wms-jobutify",
    name: "WMS (wms.jobutify.com)",
    companySlug: "jobutify",
    envVars: ["WMS_API_URL", "WMS_API_TOKEN"],
    waitingMessage: "Waiting for API access from Edil",
    metrics: ["wms_orders_day", "wms_shipment_errors"].map((key) => ({ key })),
  },
  {
    id: "alura-erp",
    name: "Alura Style ERP",
    companySlug: "alura-style",
    envVars: ["ALURA_ERP_API_URL", "ALURA_ERP_API_TOKEN"],
    waitingMessage: "Waiting for API access from Edil",
    metrics: ["output_pcs", "defect_pct", "headcount", "piecework_total"].flatMap((key) => UNITS.map((unitSlug) => ({ key, unitSlug }))),
  },
  {
    id: "wildberries",
    name: "Wildberries seller API",
    companySlug: "upsell-group",
    envVars: ["WB_API_TOKEN"],
    waitingMessage: "Needs WB token (created in the WB seller portal)",
    metrics: ["wb_sales", "wb_orders", "wb_returns"].map((key) => ({ key })),
  },
];

export function makeStubConnector(spec: StubSpec, env: Env = process.env): Connector {
  const health = async (): Promise<ConnectorHealth> => {
    const missingEnv = spec.envVars.filter((v) => !env[v]?.trim());
    if (missingEnv.length > 0) {
      return { state: "not_configured", message: spec.waitingMessage, envVars: spec.envVars, missingEnv };
    }
    return {
      state: "not_configured",
      message: "Credentials are set, but this connector is not built yet",
      envVars: spec.envVars,
      missingEnv: [],
    };
  };
  return {
    id: spec.id,
    name: spec.name,
    companySlug: spec.companySlug,
    metrics: spec.metrics,
    healthCheck: health,
    async pull(): Promise<MetricPoint[]> {
      throw new Error(`${spec.name}: not configured`);
    },
  };
}

export function stubConnectors(env: Env = process.env): Connector[] {
  return STUB_SPECS.map((s) => makeStubConnector(s, env));
}
