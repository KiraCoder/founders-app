"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";

/** Fallback for browsers without the async Clipboard API; false when the browser refused. */
function legacyCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

/**
 * Clean inline copy button with instant checkmark feedback.
 * Useful for copying IDs, digests, Telegram handles, and contacts.
 */
export function CopyButton({
  text,
  title = "Copy to clipboard",
  copiedLabel,
  className = "",
  size = 14,
}: {
  text: string;
  title?: string;
  copiedLabel?: string;
  className?: string;
  size?: number;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const show = (next: "copied" | "failed") => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text); // rejects when permission is denied
      } else if (!legacyCopy(text)) {
        throw new Error("copy command refused");
      }
      show("copied");
    } catch {
      show("failed");
    }
  };

  const copied = state === "copied";
  const label = copied ? "Copied" : state === "failed" ? "Copy failed — select the text and copy it by hand" : title;

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      title={label}
      className={`inline-flex items-center gap-1 rounded-[5px] p-1 text-muted transition-colors hover:bg-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-accent ${
        copied ? "text-accent" : state === "failed" ? "text-risk" : ""
      } ${className}`}
    >
      <Icon name={copied ? "check" : "copy"} size={size} />
      {copied && copiedLabel && (
        <span className="text-[11px] font-medium text-accent select-none">{copiedLabel}</span>
      )}
      {/* Announces the result to screen readers (the label change alone is not announced). */}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
