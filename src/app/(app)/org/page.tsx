import { ComingSoon, PageHeader } from "@/components/ui";

export const metadata = { title: "Org structure" };

export default function OrgstructurePage() {
  return (
    <>
      <PageHeader eyebrow="Group" title="Org structure" />
      <ComingSoon title="Org structure is coming in a later chunk">
        Editable org charts per company on the Vysotsky model (7 divisions, 21 departments, posts). Labels in Russian. Kiwi Go is the first example to load.
      </ComingSoon>
    </>
  );
}
