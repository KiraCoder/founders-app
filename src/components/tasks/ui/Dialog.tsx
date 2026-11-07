"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A modal dialog on the native <dialog> element (focus trap, Esc and the backdrop close it; the
 * page behind is inert). Full width on a phone, scrolls inside when long. Tasks-local for now
 * (src/components/tasks/ui); to be unified with the shared UI kit.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  role = "dialog",
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  role?: "dialog" | "alertdialog";
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      // showModal is missing in very old browsers / some test DOMs: fall back to a plain open dialog.
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) d.close();
  }, [open]);

  const width = size === "sm" ? "sm:max-w-[420px]" : size === "lg" ? "sm:max-w-[760px]" : "sm:max-w-[600px]";
  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself, outside its panel) closes it.
        if (e.target === ref.current) onClose();
      }}
      className={`m-auto w-[calc(100%-32px)] ${width} max-h-[calc(100dvh-32px)] overflow-visible rounded-[14px] border border-line bg-surface p-0 text-ink shadow-card backdrop:bg-black/45`}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-32px)] flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <h2 id={titleId} className="text-[16px] font-semibold">
                {title}
              </h2>
              {description && (
                <div id={descId} className="mt-0.5 text-[13px] text-muted">
                  {description}
                </div>
              )}
            </div>
            <button type="button" className="btn btn-ghost btn-sm -mr-1 shrink-0" onClick={onClose} aria-label="Close dialog">
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}
