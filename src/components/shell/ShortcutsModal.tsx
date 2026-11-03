"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";

const SHORTCUTS = [
  { key: "/", description: "Focus search" },
  { key: "?", description: "Show keyboard shortcuts" },
  { key: "Esc", description: "Close a dialog or menu" },
];

/** True when the key press belongs to a field the user is typing in. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'),
  );
}

/**
 * Keyboard shortcuts dialog for desktop founders, opened with "?" or the help button.
 * Global keys never fire while typing in a field or with Ctrl / Cmd / Alt held.
 * The dialog takes focus, keeps Tab inside, closes on Esc or a click outside, and gives
 * focus back to where it was.
 */
export function ShortcutsModal() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const openDialog = () => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  };
  const closeDialog = () => setOpen(false);

  // Global keys: "?" opens, "/" focuses search.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "?" && !open) {
        e.preventDefault();
        openDialog();
      } else if (e.key === "/" && !open) {
        const search = document.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search"]');
        if (search && search.offsetParent !== null) {
          e.preventDefault();
          search.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // While open: focus inside, Esc closes, Tab stays inside; focus returns on close.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      } else if (e.key === "Tab" && dialogRef.current) {
        const items = focusables(dialogRef.current);
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const back = returnTo.current;
      returnTo.current = null;
      if (back && back.isConnected) back.focus();
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="btn btn-ghost px-2 text-[12px] text-muted hover:text-ink hidden md:inline-flex"
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="font-mono text-[11px] rounded border border-line bg-sunk px-1.5 py-0.5">?</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs" onClick={closeDialog}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            className="card-raised w-full max-w-md p-5 bg-surface text-ink space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h2 id="shortcuts-title" className="text-[16px] font-semibold">
                  Keyboard shortcuts
                </h2>
                <p className="text-[12px] text-muted">They do nothing while you type in a field.</p>
              </div>
              <button ref={closeRef} type="button" className="btn btn-ghost px-1.5" onClick={closeDialog} aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </div>

            <ul className="divide-y divide-line text-[13px]">
              {SHORTCUTS.map((s) => (
                <li key={s.key} className="flex items-center justify-between py-1.5">
                  <span className="text-muted">{s.description}</span>
                  <kbd className="rounded border border-line bg-sunk px-2 py-0.5 font-mono text-[11px] font-semibold text-ink shadow-2xs">{s.key}</kbd>
                </li>
              ))}
            </ul>

            <div className="border-t border-line pt-3 text-right">
              <button type="button" className="btn btn-sm" onClick={closeDialog}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
