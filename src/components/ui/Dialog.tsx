"use client";

/**
 * Dialog — a modal on the native `<dialog>` element (focus trap, Esc, inert page behind it).
 *
 *   <Dialog open={open} onClose={() => setOpen(false)} title="New routine" description="…" size="lg">
 *     …form…
 *   </Dialog>
 *
 * - Controlled: `open` shows it (showModal), `onClose` is called on Esc, the × button and a click
 *   on the backdrop; the parent sets `open` to false.
 * - The content is mounted only while open, so a form inside starts fresh every time.
 * - Accessible name = `title` (getByRole("dialog", { name: title })). On phones it fills the width
 *   and scrolls inside; `footer` stays at the bottom.
 * - `role="alertdialog"` for a question that needs an answer (ConfirmDialog uses it).
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Accessible name when `title` is not plain text. */
  ariaLabel?: string;
  role?: "dialog" | "alertdialog";
}

const WIDTH = { sm: "min(420px, calc(100vw - 32px))", md: "min(560px, calc(100vw - 32px))", lg: "min(760px, calc(100vw - 32px))" };

export function Dialog({ open, onClose, title, description, children, footer, size = "md", ariaLabel, role = "dialog" }: DialogProps) {
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
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      role={role}
      aria-modal="true"
      aria-labelledby={ariaLabel ? undefined : titleId}
      aria-label={ariaLabel}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ width: WIDTH[size] }}
      className="m-auto max-h-[calc(100dvh-32px)] overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface p-0 text-ink shadow-[var(--shadow)] backdrop:bg-black/45"
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-34px)] flex-col">
          <div className="flex items-start gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[16px] font-semibold leading-tight">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-1 text-[13px] text-muted">
                  {description}
                </p>
              )}
            </div>
            <IconButton icon="close" label="Close" onClick={onClose} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
