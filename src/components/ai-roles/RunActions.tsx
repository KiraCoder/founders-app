"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createTaskFromFindingAction, monthTotalAction, rerunAction, type AiActionState } from "@/app/(app)/ai-roles/actions";

function Status({ state }: { state: AiActionState }) {
  if (!state.error && !state.message) return null;
  return (
    <span className={`text-[12px] ${state.error ? "text-risk" : "text-muted"}`} role="status">
      {state.error ?? state.message}
    </span>
  );
}

/** "Run again": re-checks this month's numbers now (a report is never pushed twice). */
export function RerunButton({ runId, label = "Run again" }: { runId: string; label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<AiActionState>({});
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await rerunAction(runId);
            setState(res);
            if (res.ok) router.refresh();
          })
        }
      >
        {pending ? "Checking…" : label}
      </button>
      <Status state={state} />
    </span>
  );
}

/** "Create task" on a risk finding — only when a founder clicks (never automatic). */
export function CreateTaskButton({ runId, findingId, taskId }: { runId: string; findingId: string; taskId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<AiActionState>({});
  if (taskId) {
    return (
      <Link href="/tasks?view=company" className="tag tag-ok" title="A shared task was created from this finding">
        Task created
      </Link>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await createTaskFromFindingAction(runId, findingId);
            setState(res);
            if (res.ok) router.refresh();
          })
        }
      >
        Create task
      </button>
      <Status state={state} />
    </span>
  );
}

/** In the report's missing list: "October total [   ] Save" for a daily number (role accepts month totals). */
export function MonthTotalForm({ runId, metricId, label, kind, monthName }: { runId: string; metricId: string; label: string; kind: string; monthName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState("");
  const [state, setState] = useState<AiActionState>({});
  return (
    <form
      className="inline-flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await monthTotalAction(runId, metricId, value);
          setState(res);
          if (res.ok) {
            setValue("");
            router.refresh();
          }
        });
      }}
    >
      <input
        className="input num h-8 w-32 text-right"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`${label}: ${monthName} ${kind}`}
        placeholder={`${monthName} ${kind}`}
      />
      <button type="submit" className="btn btn-sm" disabled={pending || value.trim() === ""}>
        {pending ? "Saving…" : "Save"}
      </button>
      <Status state={state} />
    </form>
  );
}
