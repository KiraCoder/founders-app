"use client";

import { useActionState, type ReactNode } from "react";
import type { StaffFormState } from "@/app/(app)/staff-actions";

/** A small form over a server action that shows its error / "Saved" line in place. */
export function ActionForm({
  action,
  children,
  className = "",
  label,
}: {
  action: (prev: StaffFormState, fd: FormData) => Promise<StaffFormState>;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(action, {});
  return (
    <form action={formAction} className={`${className} ${pending ? "opacity-60" : ""}`} aria-label={label}>
      {children}
      {state.error && (
        <p role="alert" className="mt-1 w-full text-[12px] text-risk">
          {state.error}
        </p>
      )}
      {state.ok && state.message && (
        <p role="status" className="mt-1 w-full text-[12px] text-ok">
          {state.message}
        </p>
      )}
    </form>
  );
}
