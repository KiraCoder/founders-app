import { ComingSoon, PageHeader } from "@/components/ui";

export const metadata = { title: "Holding" };

export default function HoldingPage() {
  return (
    <>
      <PageHeader eyebrow="Group" title="Holding" />
      <ComingSoon title="Holding is coming in a later chunk">
        Intercompany contracts, monthly акты приёма-передачи and debts between group companies. The app will push you to ask Elmurat about missing months.
      </ComingSoon>
    </>
  );
}
