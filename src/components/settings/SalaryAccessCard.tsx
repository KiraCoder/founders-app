"use client";

import { useState, useTransition } from "react";
import { setSalaryViewerAction } from "@/app/(app)/people/actions";
import { Tag } from "@/components/ui";

export interface SalaryViewerItem {
  userId: string;
  name: string;
  shortName: string;
  isViewer: boolean;
}

/** One-click salary access toggles. Only an existing salary viewer can change them. */
export function SalaryAccessCard({ viewers, canEdit, currentUserId }: { viewers: SalaryViewerItem[]; canEdit: boolean; currentUserId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggle = (v: SalaryViewerItem) =>
    start(async () => {
      const r = await setSalaryViewerAction(v.userId, !v.isViewer);
      setError(r.error ?? null);
    });
  return (
    <div>
      <p className="mb-3 text-[13px] text-muted">
        Who can see and change salaries (people list, company pages, person page, API, import). Everyone else does not see
        salary columns at all. Default: both founders.
        {!canEdit && " Only a salary viewer can change this."}
      </p>
      <ul className="divide-y divide-line rounded-[8px] border border-line">
        {viewers.map((v) => (
          <li key={v.userId} className="flex items-center gap-3 px-3 py-2.5" data-testid={`salary-viewer-${v.shortName}`}>
            <span className="font-medium">{v.shortName}</span>
            {v.userId === currentUserId && <span className="text-[12px] text-muted">(you)</span>}
            <span className="ml-auto">{v.isViewer ? <Tag tone="warn">Sees salaries</Tag> : <Tag>No salary access</Tag>}</span>
            <button
              type="button"
              role="switch"
              aria-checked={v.isViewer}
              aria-label={`Salary access for ${v.shortName}`}
              disabled={!canEdit || pending}
              onClick={() => toggle(v)}
              className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
                v.isViewer ? "border-accent bg-accent" : "border-line bg-sunk"
              }`}
            >
              <span
                className={`absolute top-0.5 size-[18px] rounded-full bg-surface shadow transition-all ${v.isViewer ? "left-[22px]" : "left-0.5"}`}
              />
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="mt-2 text-[12px] text-risk" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
