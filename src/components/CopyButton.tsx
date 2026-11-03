"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";

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
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed (e.g. permission denied)
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : title}
      title={copied ? "Copied!" : title}
      className={`inline-flex items-center gap-1 rounded-[5px] p-1 text-muted transition-colors hover:bg-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-accent ${
        copied ? "text-accent" : ""
      } ${className}`}
    >
      <Icon name={copied ? "check" : "copy"} size={size} />
      {copied && copiedLabel && (
        <span className="text-[11px] font-medium text-accent select-none">{copiedLabel}</span>
      )}
    </button>
  );
}
