import { PeopleList } from "@/components/PeopleList";
import { PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { listPeople } from "@/server/services/people";

export const metadata = { title: "People" };

export default async function PeoplePage() {
  const ctx = await getPageContext();
  const people = await listPeople(ctx);
  return (
    <>
      <PageHeader eyebrow="Group" title="People">
        <p className="mt-1 text-[13px] text-muted">
          One shared list across companies. Salaries will live in a separate, restricted section.
        </p>
      </PageHeader>
      <PeopleList people={people} />
    </>
  );
}
