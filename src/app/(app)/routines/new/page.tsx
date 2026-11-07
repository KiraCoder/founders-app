import Link from "next/link";
import { notFound } from "next/navigation";
import { RoutineForm } from "@/components/routines/RoutineForm";
import { EMPTY_ROUTINE } from "@/components/routines/form-values";
import { PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { canManageRoutines } from "@/server/services/access";
import { routineFormOptions } from "@/server/services/routines";
import { createRoutineAction } from "../actions";

export const metadata = { title: "New routine" };

export default async function NewRoutinePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await getPageContext();
  if (!canManageRoutines(ctx)) notFound();
  const sp = await searchParams;
  const options = await routineFormOptions(ctx);
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/routines" className="hover:underline">
            Routines
          </Link>
        }
        title="New routine"
      />
      <RoutineForm
        action={createRoutineAction}
        initial={{ ...EMPTY_ROUTINE, assignee: sp.who ?? "", companyId: sp.company ?? "" }}
        options={options}
        submitLabel="Create routine"
      />
    </>
  );
}
