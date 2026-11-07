/**
 * IconButton — a square icon-only button (or link) with an accessible name and a tooltip.
 *
 *   <IconButton icon="play" label="Run now" onClick={…} />
 *   <IconButton icon="external" label="Open" href={`/routines/${id}`} />
 *   <IconButton icon="trash" label="Delete" tone="danger" type="submit" />
 *
 * `label` is both the aria-label and the hover tooltip (title), so tests and screen readers find
 * it by name. `badge` shows a small count (e.g. comments). Works in server and client components
 * (no hooks); pass `onClick` only from a client component.
 */
import Link from "next/link";
import type { ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "@/components/Icon";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  label: string;
  tone?: "default" | "primary" | "danger";
  size?: "sm" | "md";
  /** Render as a link. */
  href?: string;
  /** A small number shown on the button (0 / undefined = none). */
  badge?: number;
}

export function IconButton({ icon, label, tone = "default", size = "md", href, badge, className = "", type = "button", ...rest }: IconButtonProps) {
  const dim = size === "sm" ? "h-7 min-w-7" : "h-8 min-w-8";
  const color =
    tone === "primary" ? "text-accent hover:bg-accent-soft" : tone === "danger" ? "text-risk hover:bg-risk-soft" : "text-muted hover:bg-sunk hover:text-ink";
  const cls = `relative inline-flex ${dim} items-center justify-center gap-1 rounded-[var(--radius-btn)] px-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-40 disabled:pointer-events-none ${color} ${className}`;
  const inner = (
    <>
      <Icon name={icon} size={size === "sm" ? 15 : 17} />
      {badge ? <span className="num text-[11px] font-semibold leading-none">{badge}</span> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} aria-label={label} title={label} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type={type} aria-label={label} title={label} className={cls} {...rest}>
      {inner}
    </button>
  );
}
