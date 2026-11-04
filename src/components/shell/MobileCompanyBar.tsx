"use client";

import { CompanySwitcher, useCurrentCompany } from "./CompanySwitcher";
import type { NavCompany } from "./company-nav";

/** Phone-only strip under the top bar with the company switcher (the sidebar is hidden there). */
export function MobileCompanyBar({ companies, initialCompany = null }: { companies: NavCompany[]; initialCompany?: string | null }) {
  const { company, forget } = useCurrentCompany(companies, initialCompany);
  return (
    <div className="relative z-10 border-b border-line bg-surface px-4 py-2 md:hidden">
      <CompanySwitcher companies={companies} current={company} onForget={forget} className="max-w-[360px]" />
    </div>
  );
}
