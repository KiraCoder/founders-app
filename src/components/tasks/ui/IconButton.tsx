"use client";

import Link from "next/link";
import type { ReactNode } from "react";

const base =
  "group relative inline-grid size-9 shrink-0 place-items-center rounded-[8px] border border-transparent text-[16px] leading-none text-muted transition-colors hover:border-line hover:bg-sunk hover:text-ink focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 sm:size-8";

function Tip({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-[6px] bg-ink px-2 py-1 text-[11px] font-medium text-bg opacity-0 shadow-card transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 sm:block"
    >
      {label}
    </span>
  );
}

/** A square icon button with an accessible name and a tooltip (hover / keyboard focus). */
export function IconButton({
  label,
  children,
  onClick,
  disabled,
  pressed,
  tone,
  testId,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  tone?: "ok" | "risk";
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={`${base} ${tone === "ok" ? "hover:text-ok" : tone === "risk" ? "hover:text-risk" : ""} ${pressed ? "border-line bg-sunk text-ink" : ""}`}
    >
      <span aria-hidden="true">{children}</span>
      <Tip label={label} />
    </button>
  );
}

/** The same look for a link (↗ Open). */
export function IconLink({ label, href, children }: { label: string; href: string; children: ReactNode }) {
  return (
    <Link href={href} aria-label={label} title={label} className={base}>
      <span aria-hidden="true">{children}</span>
      <Tip label={label} />
    </Link>
  );
}
