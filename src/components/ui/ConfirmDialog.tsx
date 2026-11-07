"use client";

/**
 * ConfirmDialog — "are you sure?" before an action with consequences (archive, delete, an edit
 * that changes an open run).
 *
 *   <ConfirmDialog
 *     open={ask} title="Archive this routine?" message="It stops asking; the history stays."
 *     confirmLabel="Archive" tone="danger" onConfirm={doIt} onCancel={() => setAsk(false)}
 *     secondary={{ label: "Save and add to today too", onClick: … }}   // optional second choice
 *   />
 *
 * Buttons: Cancel, the optional `secondary` choice, then the confirm button (focused first).
 */
import type { ReactNode } from "react";
import { Dialog } from "./Dialog";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
  secondary?: { label: string; onClick: () => void };
  busy?: boolean;
}

export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel = "Cancel", tone = "primary", onConfirm, onCancel, secondary, busy }: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          {secondary && (
            <button type="button" className="btn" onClick={secondary.onClick} disabled={busy}>
              {secondary.label}
            </button>
          )}
          <button type="button" autoFocus className={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-[14px] leading-relaxed">{message}</div>
    </Dialog>
  );
}
