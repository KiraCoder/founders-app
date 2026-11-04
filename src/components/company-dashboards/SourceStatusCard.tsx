import { DataSources } from "@/components/metrics/DataSources";
import { Tag } from "@/components/ui";
import type { ConnectorStatus } from "@/server/services/connectors";

/**
 * Status of one named data source. When the connector is not registered (its code is not
 * in the app yet), shows "Not configured" instead of nothing.
 */
export function SourceStatusCard({
  connectorId,
  sources,
  timeZone,
}: {
  connectorId: string;
  sources: ConnectorStatus[];
  timeZone: string;
}) {
  const source = sources.find((s) => s.id === connectorId);
  return (
    <div className="card border-l-4 border-l-(color:--kind-accent) px-4 py-1" data-testid="source-status" data-connector={connectorId}>
      {source ? (
        <DataSources sources={[source]} timeZone={timeZone} />
      ) : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13px]">
          <span className="font-medium">
            Data source <code className="num">{connectorId}</code>
          </span>
          <Tag tone="warn">Not configured</Tag>
          <span className="text-muted">This connector is not set up yet. Numbers can be entered or uploaded by hand meanwhile.</span>
        </p>
      )}
    </div>
  );
}
