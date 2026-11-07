/**
 * BackLink — "← Back" (arrow + text) at the top of a detail page.
 *
 *   <BackLink href="/routines" />                 // "Back"
 *   <BackLink href="/routines">Routines</BackLink> // "← Routines"
 *
 * A plain link (server or client component); its accessible name is the text.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";

export function BackLink({ href, children = "Back", className = "" }: { href: string; children?: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-btn)] py-1 pr-2 text-[13px] font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent ${className}`}
    >
      <Icon name="arrowLeft" size={16} />
      {children}
    </Link>
  );
}
