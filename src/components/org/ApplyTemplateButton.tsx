"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { applyTemplateAction } from "@/app/(app)/org/actions";

export function ApplyTemplateButton({ companyId, companyUnitId }: { companyId: string; companyUnitId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await applyTemplateAction(companyId, companyUnitId);
            if (res.ok) router.refresh();
            else setError(res.error ?? "Could not apply the template");
          })
        }
      >
        {pending ? "Applying…" : "Apply Vysotsky template (7 divisions / 21 departments)"}
      </button>
      {error && (
        <p role="alert" className="text-[12px] text-risk">
          {error}
        </p>
      )}
    </div>
  );
}
