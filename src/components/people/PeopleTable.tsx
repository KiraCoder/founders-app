import Link from "next/link";
import { CopyButton } from "@/components/CopyButton";
import { CompanyDot, InitialsAvatar, Tag } from "@/components/ui";
import { EMPLOYMENT_TYPE_LABELS, PAY_TYPE_LABELS } from "@/lib/people-schemas";
import { formatMoney } from "@/lib/money";
import type { PersonView } from "@/server/services/people";

/**
 * People table. The salary column is rendered only when `showSalary` is true, which pages
 * set from `canViewSalaries`; the data itself only carries salaries for viewers anyway.
 */
export function PeopleTable({
  people,
  showSalary,
  showCompany = true,
  empty = "No people found.",
}: {
  people: PersonView[];
  showSalary: boolean;
  showCompany?: boolean;
  empty?: string;
}) {
  if (people.length === 0) {
    return <div className="card px-4 py-6 text-center text-[13px] text-muted">{empty}</div>;
  }
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[13px]" data-testid="people-table">
        <thead>
          <tr className="border-b border-line">
            <th className="eyebrow px-4 py-2 font-semibold">Name</th>
            <th className="eyebrow px-3 py-2 font-semibold">{showCompany ? "Role · company" : "Role · unit"}</th>
            <th className="eyebrow px-3 py-2 font-semibold">Contact</th>
            {showSalary && (
              <th className="eyebrow px-4 py-2 text-right font-semibold" data-testid="salary-header">
                Salary
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {people.map((p) => (
            <tr key={p.id} className="align-top hover:bg-sunk/50">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                  <InitialsAvatar name={p.fullName} size={30} />
                  <div className="min-w-0">
                    <Link href={`/people/${p.id}`} className="font-medium hover:underline">
                      {p.fullName}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      {p.shortName && <span className="text-[12px] text-muted">{p.shortName}</span>}
                      {p.isUser && <Tag tone="ok">App user</Tag>}
                      {p.leftAt && <Tag tone="warn">Left</Tag>}
                    </div>
                  </div>
                </div>
              </td>
              <td className="px-3 py-2.5">
                {p.roles.length === 0 && <span className="text-muted">—</span>}
                <ul className="space-y-1">
                  {p.roles.map((r) => (
                    <li key={r.id} className={`flex flex-wrap items-center gap-1.5 ${r.isActive ? "" : "text-muted line-through"}`}>
                      {showCompany && <CompanyDot color={r.companyColor} />}
                      <span>{r.title ?? r.role}</span>
                      {showCompany && <span className="text-muted">· {r.companyName}</span>}
                      {r.unitName && <Tag>{r.unitName}</Tag>}
                      {r.employmentType !== "staff" && <Tag tone="info">{EMPLOYMENT_TYPE_LABELS[r.employmentType]}</Tag>}
                    </li>
                  ))}
                </ul>
              </td>
              <td className="px-3 py-2.5 text-[12px] text-muted">
                {p.phone && (
                  <div className="group/phone flex items-center gap-1 num whitespace-nowrap">
                    <span>{p.phone}</span>
                    <CopyButton text={p.phone} title={`Copy phone for ${p.fullName}`} size={12} className="opacity-0 group-hover/phone:opacity-100 transition-opacity" />
                  </div>
                )}
                {p.telegramHandle && (
                  <div className="group/tg flex items-center gap-1">
                    <span>@{p.telegramHandle}</span>
                    <CopyButton text={`@${p.telegramHandle}`} title={`Copy Telegram handle for ${p.fullName}`} size={12} className="opacity-0 group-hover/tg:opacity-100 transition-opacity" />
                  </div>
                )}
                {p.email && (
                  <div className="group/email flex items-center gap-1 truncate">
                    <span className="truncate">{p.email}</span>
                    <CopyButton text={p.email} title={`Copy email for ${p.fullName}`} size={12} className="opacity-0 group-hover/email:opacity-100 transition-opacity" />
                  </div>
                )}
              </td>
              {showSalary && (
                <td className="px-4 py-2.5 text-right">
                  <ul className="space-y-1">
                    {p.roles.map((r) => (
                      <li key={r.id} className="num whitespace-nowrap" data-testid="salary-cell">
                        {r.salary ? (
                          <>
                            {formatMoney(r.salary.amount, r.salary.currency)}
                            {r.salary.payType !== "monthly" && (
                              <span className="ml-1 text-[11px] text-muted">{PAY_TYPE_LABELS[r.salary.payType].toLowerCase()}</span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
