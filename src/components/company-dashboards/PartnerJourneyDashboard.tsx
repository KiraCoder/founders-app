import Link from "next/link";
import { Section } from "@/components/ui";
import { listPartnerJourney } from "@/server/services/client-projects";
import type { ServiceContext } from "@/server/services/context";
import { JOURNEY_EDIT_HREF } from "./templates";

/** Upsell: the partner journey strip (read-only) with the people working at each step. */
export async function PartnerJourneyDashboard({ ctx, company }: { ctx: ServiceContext; company: { id: string; slug: string } }) {
  const steps = await listPartnerJourney(ctx, company.id);
  const total = new Set(steps.flatMap((s) => s.partners.map((p) => p.id))).size;
  return (
    <div data-testid="dashboard-sales-partners">
      <Section
        title="Partner journey"
        count={total}
        action={
          <Link href={JOURNEY_EDIT_HREF(company.slug)} className="text-[12px] text-accent hover:underline">
            Edit the journey
          </Link>
        }
      >
        {steps.length === 0 ? (
          <div className="card px-4 py-6 text-center text-[13px] text-muted">
            No journey steps yet.{" "}
            <Link href={JOURNEY_EDIT_HREF(company.slug)} className="text-accent hover:underline">
              Add them on the Org structure page
            </Link>
            .
          </div>
        ) : (
          <ol className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2" data-testid="journey-strip">
            {steps.map((s, i) => (
              <li key={s.id} className="flex shrink-0 items-stretch gap-2">
                <div className="card w-[200px] border-t-4 border-t-(color:--kind-accent) p-3" data-testid="journey-step">
                  <p className="flex items-center gap-2">
                    <span className="num inline-flex h-6 w-6 items-center justify-center rounded-full bg-(--kind-accent-soft) text-[12px] font-semibold text-(color:--kind-accent)">
                      {s.number}
                    </span>
                    <span className="text-[13px] font-semibold leading-5">{s.label}</span>
                  </p>
                  <p className="mt-1 text-[11px] text-muted">{s.departmentName ?? "No department linked"}</p>
                  <p className="mt-2 text-[12px]">
                    <span className="num text-[18px] font-semibold" data-testid="journey-count">
                      {s.partners.length}
                    </span>{" "}
                    <span className="text-muted">{s.partners.length === 1 ? "person" : "people"}</span>
                  </p>
                  {s.partners.length > 0 && (
                    <p className="mt-1 text-[12px] text-muted">
                      {s.partners
                        .slice(0, 4)
                        .map((p) => p.name)
                        .join(", ")}
                      {s.partners.length > 4 && ` +${s.partners.length - 4}`}
                    </p>
                  )}
                </div>
                {i < steps.length - 1 && (
                  <span aria-hidden="true" className="self-center text-muted">
                    →
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
