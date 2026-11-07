import Link from "next/link";
import type { OrgFinding } from "@/lib/org";

/**
 * The Org Structure Expert's strip above the board: rule-based findings (no AI), grouped one
 * per rule. Warnings first, info (functions without a responsible person) muted.
 */
export function OrgExpertStrip({ findings, compact = false }: { findings: OrgFinding[]; compact?: boolean }) {
  const warnings = findings.filter((f) => f.severity === "warning");
  const info = findings.filter((f) => f.severity === "info");
  return (
    <section className="card mb-4 px-4 py-3" aria-label="Org Structure Expert" data-testid="org-expert-strip">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold">Org Structure Expert</span>
        <span className={`tag ${warnings.length ? "tag-warn" : "tag-ok"}`}>
          {warnings.length ? `${warnings.length} thing${warnings.length === 1 ? "" : "s"} to fix` : "Looks complete"}
        </span>
        {!compact && (
          <span className="text-[12px] text-muted">
            Rule-based checks. Brainstorming and advice appear after the AI provider is chosen ·{" "}
            <Link href="/ai-roles" className="text-accent hover:underline">
              AI roles
            </Link>
          </span>
        )}
      </div>
      {findings.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-[13px]">
          {[...warnings, ...info].map((f) => (
            <li key={f.rule} className={f.severity === "info" ? "text-muted" : ""}>
              <details>
                <summary className="cursor-pointer">
                  <span className={`mr-1.5 inline-block size-2 rounded-full ${f.severity === "warning" ? "bg-warn" : "bg-line"}`} aria-hidden="true" />
                  {f.text}
                </summary>
                {f.items.length > 0 && (
                  <p className="mt-1 pl-4 text-[12px] text-muted">
                    {f.items.join(" · ")}
                    {f.count > f.items.length ? ` · +${f.count - f.items.length} more` : ""}
                  </p>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
