import { Suspense } from "react";
import { cookies } from "next/headers";
import { BottomTabs } from "@/components/shell/BottomTabs";
import { MobileCompanyBar } from "@/components/shell/MobileCompanyBar";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { Toaster } from "@/components/ui/Toast";
import { COMPANY_COOKIE, type NavCompany } from "@/components/shell/company-nav";
import { getPageContext } from "@/server/context";
import { devToolsEnabled } from "@/server/notifications/config";
import { listCompanies } from "@/server/services/companies";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getPageContext();
  // Non-archived companies this user can see, trimmed to what the shell needs (plain, serialisable).
  const companies: NavCompany[] = (await listCompanies(ctx)).map((c) => ({ slug: c.slug, name: c.name, color: c.color, status: c.status }));
  // The company remembered from the last company page, for scoping the sidebar on global pages.
  const rememberedCompany = (await cookies()).get(COMPANY_COOKIE)?.value ?? null;
  // Hired AI roles + latest report links for the agent panel (a failure never breaks the shell).
  // Streamed: TopBar gets the promise and only the (closed) panel waits for it. The service is
  // imported lazily so the shell's module graph does not include the AI roles engine.
  const agentHires = import("@/server/services/ai-roles").then((m) => m.agentPanelHires(ctx)).catch(() => []);
  return (
    <div className="flex min-h-dvh">
      <Sidebar companies={companies} initialCompany={rememberedCompany} showDevTools={devToolsEnabled()} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<div className="h-14 border-b border-line bg-surface" />}>
          <TopBar user={{ name: ctx.user.name, shortName: ctx.user.shortName, email: ctx.user.email }} agentHires={agentHires} />
        </Suspense>
        <MobileCompanyBar companies={companies} initialCompany={rememberedCompany} />
        <main className="mx-auto w-full max-w-[1120px] flex-1 px-4 pb-24 pt-5 md:px-8 md:pb-10 md:pt-7">{children}</main>
      </div>
      <BottomTabs />
      <Toaster />
    </div>
  );
}
