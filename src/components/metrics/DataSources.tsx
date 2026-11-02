import Link from "next/link";
import { Tag } from "@/components/ui";
import type { ConnectorStatus } from "@/server/services/connectors";
import { CheckNowButton } from "./CheckNowButton";

/** Status of each automatic data source ("Waiting for API access from Edil", "Needs WB token"). */
export function DataSources({ sources, timeZone, showCompany }: { sources: ConnectorStatus[]; timeZone: string; showCompany?: boolean }) {
  if (sources.length === 0) return <p className="text-[13px] text-muted">No automatic data source for this company. Enter or upload numbers.</p>;
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });
  return (
    <ul className="divide-y divide-line" data-testid="data-sources">
      {sources.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13px]">
          <span className="font-medium">{s.name}</span>
          {showCompany && (
            <Link href={`/companies/${s.companySlug}`} className="text-[12px] text-muted hover:underline">
              {s.companyName}
            </Link>
          )}
          <Tag tone={s.health.state === "ok" ? "ok" : s.health.state === "error" ? "risk" : "warn"}>
            {s.health.state === "ok" ? "Connected" : s.health.state === "error" ? "Error" : "Not configured"}
          </Tag>
          <span className="text-muted">{s.health.message}</span>
          {s.health.missingEnv.length > 0 && (
            <span className="text-[11px] text-muted">
              needs <code className="num">{s.health.missingEnv.join(", ")}</code>
            </span>
          )}
          <span className="ml-auto flex items-center gap-2 text-[11px] text-muted">
            {s.lastRun ? `Last check ${fmt.format(new Date(s.lastRun.at))}: ${s.lastRun.status.replace("_", " ")}` : "Never checked"}
            <CheckNowButton connectorId={s.id} />
          </span>
        </li>
      ))}
    </ul>
  );
}
