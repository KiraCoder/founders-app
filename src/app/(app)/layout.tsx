import { Suspense } from "react";
import { BottomTabs } from "@/components/shell/BottomTabs";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { getPageContext } from "@/server/context";
import { listCompanies } from "@/server/services/companies";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getPageContext();
  const companies = await listCompanies(ctx);
  return (
    <div className="flex min-h-dvh">
      <Sidebar companies={companies} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<div className="h-14 border-b border-line bg-surface" />}>
          <TopBar user={{ name: ctx.user.name, shortName: ctx.user.shortName, email: ctx.user.email }} />
        </Suspense>
        <main className="mx-auto w-full max-w-[1120px] flex-1 px-4 pb-24 pt-5 md:px-8 md:pb-10 md:pt-7">{children}</main>
      </div>
      <BottomTabs />
    </div>
  );
}
