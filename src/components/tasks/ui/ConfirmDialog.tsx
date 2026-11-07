"use client";

import type { ReactNode } from "react";
import { Dialog } from "./Dialog";

/** "Are you sure?" before deleting, archiving or a change that messages a staff member. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "primary",
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onClose={onCancel} title={title} role="alertdialog" size="sm">
      <div className="space-y-4 text-[14px]">
        <div className="space-y-2">{children}</div>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={pending}
            autoFocus
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
