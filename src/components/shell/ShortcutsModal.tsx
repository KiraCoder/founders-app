"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";

const SHORTCUT_GROUPS = [
  {
    title: "Navigation",
    shortcuts: [
      { key: "/", description: "Focus search bar" },
      { key: "Esc", description: "Close modal / drawer" },
      { key: "?", description: "Show keyboard shortcuts" },
    ],
  },
  {
    title: "Views",
    shortcuts: [
      { key: "Today", description: "Daily overview and overdue items" },
      { key: "My tasks", description: "Personal and assigned todos" },
      { key: "Companies", description: "Numbers, org, and KPI tracking" },
      { key: "Holding", description: "Intercompany contracts, debts, акты" },
    ],
  },
];

/**
 * Keyboard shortcuts modal helper for desktop founders.
 * Triggered via '?' key or via a help button.
 */
export function ShortcutsModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input or textarea
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-ghost px-2 text-[12px] text-muted hover:text-ink hidden md:inline-flex"
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
      >
        <span className="font-mono text-[11px] rounded border border-line bg-sunk px-1.5 py-0.5">?</span>
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs"
      onClick={() => setOpen(false)}
    >
      <div
        className="card-raised w-full max-w-md p-5 bg-surface text-ink space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <h2 id="shortcuts-title" className="text-[16px] font-semibold">
              Keyboard Shortcuts
            </h2>
            <p className="text-[12px] text-muted">Quick navigation across Founder Cockpit</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost px-1.5"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="space-y-4">
          {SHORTCUT_GROUPS.map((group, idx) => (
            <div key={idx} className="space-y-2">
              <p className="eyebrow">{group.title}</p>
              <ul className="divide-y divide-line text-[13px]">
                {group.shortcuts.map((s, sIdx) => (
                  <li key={sIdx} className="flex items-center justify-between py-1.5">
                    <span className="text-muted">{s.description}</span>
                    <kbd className="rounded border border-line bg-sunk px-2 py-0.5 font-mono text-[11px] font-semibold text-ink shadow-2xs">
                      {s.key}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-t border-line pt-3 text-right">
          <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
