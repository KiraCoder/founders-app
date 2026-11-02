/**
 * The list of known connectors. To plug in a real source: implement `Connector`
 * (types.ts) in its own file and return it here instead of the stub.
 */
import { stubConnectors } from "./stubs";
import type { Connector } from "./types";

export class ConnectorRegistry {
  private readonly byId = new Map<string, Connector>();
  constructor(connectors: Connector[]) {
    for (const c of connectors) this.byId.set(c.id, c);
  }
  get(id: string): Connector | undefined {
    return this.byId.get(id);
  }
  all(): Connector[] {
    return [...this.byId.values()];
  }
  forCompany(slug: string): Connector[] {
    return this.all().filter((c) => c.companySlug === slug);
  }
}

export function defaultRegistry(env: Record<string, string | undefined> = process.env): ConnectorRegistry {
  return new ConnectorRegistry(stubConnectors(env));
}
