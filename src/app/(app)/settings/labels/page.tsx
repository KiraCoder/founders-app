import Link from "next/link";
import { LabelsManager } from "@/components/settings/LabelsManager";
import { PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { LABEL_COLORS, listLabels } from "@/server/services/task-labels";

export const metadata = { title: "Labels · Settings" };

export default async function LabelsSettingsPage() {
  const ctx = await getPageContext();
  const labels = await listLabels(ctx, { includeArchived: true, withUses: true });
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/settings" className="hover:underline">
            Settings
          </Link>
        }
        title="Labels"
      />
      <p className="mb-4 text-[13px] text-muted">
        Labels tag tasks across companies (a colored dot on each row). New ones can also be made right from a task&apos;s label picker. A label
        some task uses can be archived (it stays on those tasks, it is no longer offered); an unused one can be deleted.
      </p>
      <LabelsManager labels={labels.map((l) => ({ id: l.id, name: l.name, color: l.color, archived: l.archived, uses: l.uses ?? 0 }))} palette={[...LABEL_COLORS]} />
    </>
  );
}
