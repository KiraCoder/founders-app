import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/Icon";
import { AddLinkForm, LinkActiveButton, PersonStatusButton, SalaryForm } from "@/components/people/PersonActions";
import { EditPersonForm } from "@/components/people/PersonForm";
import { CompanyDot, PageHeader, Section, Tag } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { EMPLOYMENT_TYPE_LABELS, PAY_TYPE_LABELS } from "@/lib/people-schemas";
import { getPageContext } from "@/server/context";
import { ServiceError } from "@/server/services/errors";
import { orgPositionsForPerson, type OrgPosition } from "@/server/services/org";
import { getPerson, listCompanyUnitOptions } from "@/server/services/people";
import { canViewSalaries } from "@/server/services/salaries";
import { canManageStaffBot } from "@/server/services/access";
import { getTeamMember } from "@/server/services/staff";
import { InviteToTelegram } from "@/components/staff/InviteToTelegram";

export const metadata = { title: "Person" };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getPageContext();
  const showSalary = await canViewSalaries(ctx);
  let person;
  try {
    person = await getPerson(ctx, id, { salaryScope: "person" });
  } catch (err) {
    if (err instanceof ServiceError && err.code === "not_found") notFound();
    throw err;
  }
  const positions = await orgPositionsForPerson(ctx, person.id);
  const companies = (await listCompanyUnitOptions(ctx)).map((c) => ({ id: c.id, name: c.name, units: c.units.map((u) => ({ id: u.id, name: u.name })) }));
  const left = person.leftAt !== null;
  const tg = canManageStaffBot(ctx) && !person.isUser ? await getTeamMember(ctx, person.id) : null;
  const TG_TEXT = {
    not_linked: "Not on Telegram yet. Invite them: they open the link and press Start.",
    invited: "Invited — waiting for them to open the link.",
    linked: "Linked to the bot.",
    stopped: "They stopped the bot (/stop). Nothing is sent until they send /start.",
  } as const;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/people" className="hover:underline">
            People
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            {person.fullName}
            {left && <Tag tone="warn">Left</Tag>}
            {person.isUser && <Tag tone="ok">App user</Tag>}
          </span>
        }
        actions={<PersonStatusButton personId={person.id} left={left} />}
      />

      {tg && !left && (
        <section className="card mb-5 p-4" aria-labelledby="person-tg-heading" data-testid="person-telegram-card">
          <h2 id="person-tg-heading" className="eyebrow mb-2">
            Telegram
          </h2>
          <p className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
            <Tag tone={tg.reachable ? "ok" : tg.state === "linked" ? "info" : "warn"}>
              {tg.reachable ? "Bot messages them" : tg.state === "linked" ? (tg.botEnabled ? "Paused" : "Bot may not message yet") : tg.state.replace("_", " ")}
            </Tag>
            <span>{TG_TEXT[tg.state]}</span>
            <Link href="/settings/team-telegram" className="text-accent hover:underline">
              Team on Telegram settings
            </Link>
          </p>
          {tg.state !== "linked" && <InviteToTelegram personId={person.id} personName={person.shortName || person.fullName} />}
        </section>
      )}

      <Section title="Companies and roles" count={person.roles.filter((r) => r.isActive).length}>
        <ul className="card mb-3 divide-y divide-line">
          {person.roles.length === 0 && <li className="px-4 py-4 text-[13px] text-muted">Not linked to any company yet.</li>}
          {person.roles.map((r) => (
            <li key={r.id} className="px-4 py-3" data-testid="person-role">
              <div className="flex flex-wrap items-center gap-2">
                <CompanyDot color={r.companyColor} />
                <Link href={`/companies/${r.companySlug}?tab=people`} className="font-medium hover:underline">
                  {r.companyName}
                </Link>
                <span>· {r.title ?? r.role}</span>
                {r.unitName && <Tag>{r.unitName}</Tag>}
                <Tag tone={r.employmentType === "staff" ? "neutral" : "info"}>{EMPLOYMENT_TYPE_LABELS[r.employmentType]}</Tag>
                {!r.isActive && <Tag tone="warn">Ended {r.endedOn ?? ""}</Tag>}
                {r.startedOn && <span className="text-[12px] text-muted">since {r.startedOn}</span>}
                <span className="ml-auto">
                  <LinkActiveButton linkId={r.id} active={r.isActive} />
                </span>
              </div>
              {showSalary && (
                <div className="mt-2 rounded-[8px] bg-sunk px-3 py-2 text-[13px]" data-testid="salary-block">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="lock" size={14} className="text-warn" />
                    <span className="text-muted">Current salary:</span>
                    <span className="num font-semibold">
                      {r.salary ? formatMoney(r.salary.amount, r.salary.currency) : "—"}
                    </span>
                    {r.salary && <span className="text-muted">{PAY_TYPE_LABELS[r.salary.payType].toLowerCase()} · from {r.salary.effectiveFrom}</span>}
                    <span className="ml-auto">
                      <SalaryForm linkId={r.id} />
                    </span>
                  </div>
                  {r.salaryHistory && r.salaryHistory.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[12px] text-muted">History ({r.salaryHistory.length})</summary>
                      <table className="mt-1 w-full text-[12px]">
                        <tbody>
                          {r.salaryHistory.map((s) => (
                            <tr key={s.id} className="border-t border-line">
                              <td className="py-1 pr-3">{s.effectiveFrom}</td>
                              <td className="num py-1 pr-3 text-right">{formatMoney(s.amount, s.currency)}</td>
                              <td className="py-1 pr-3 text-muted">{PAY_TYPE_LABELS[s.payType].toLowerCase()}</td>
                              <td className="py-1 pr-3 text-muted">{s.note ?? ""}</td>
                              <td className="py-1 text-right text-muted">{s.createdByName ?? ""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        <AddLinkForm personId={person.id} companies={companies} showSalary={showSalary} />
      </Section>

      <Section title="Org positions" count={positions.length}>
        <ul className="card mb-3 divide-y divide-line" data-testid="person-org-positions">
          {positions.length === 0 && <li className="px-4 py-4 text-[13px] text-muted">Not on any org chart yet. Assign people on the Org structure board.</li>}
          {positions.map((p, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-[13px]" data-testid="person-org-position">
              <Tag tone={p.kind === "function" ? "neutral" : "ok"}>{POSITION_LABEL[p.kind]}</Tag>
              <CompanyDot color={p.companyColor} />
              <Link href={orgHref(p)} className="font-medium hover:underline">
                {p.companyName}
                {p.unitName ? ` · ${p.unitName}` : ""}
              </Link>
              <span className="text-muted">·</span>
              <span>{p.division}</span>
              {p.department && (
                <>
                  <span className="text-muted">·</span>
                  <span>{p.department}</span>
                </>
              )}
              {p.function && (
                <>
                  <span className="text-muted">·</span>
                  <span className="text-muted">{p.function}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Details">
        <div className="card p-4 md:p-5">
          <EditPersonForm
            values={{
              id: person.id,
              fullName: person.fullName,
              shortName: person.shortName,
              phone: person.phone,
              telegramHandle: person.telegramHandle,
              email: person.email,
              notes: person.notes,
            }}
          />
        </div>
      </Section>
    </>
  );
}

const POSITION_LABEL: Record<OrgPosition["kind"], string> = { division_head: "Head of division", department_head: "Head of department", function: "Function" };

function orgHref(p: OrgPosition): string {
  const q = new URLSearchParams({ company: p.companySlug });
  if (p.unitSlug) q.set("unit", p.unitSlug);
  return `/org?${q.toString()}`;
}
