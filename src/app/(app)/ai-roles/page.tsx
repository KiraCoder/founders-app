import { ComingSoon, PageHeader } from "@/components/ui";

export const metadata = { title: "AI roles" };

export default function AIrolesPage() {
  return (
    <>
      <PageHeader eyebrow="Group" title="AI roles" />
      <ComingSoon title="AI roles is coming in a later chunk">
        Hire an AI agent for a role in a company: what it owns, which data it needs, how often it runs. First role: AI Financial Analyst. Starts after the AI provider is chosen.
      </ComingSoon>
    </>
  );
}
