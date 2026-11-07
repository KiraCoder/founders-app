import Link from "next/link";

/** "← Back" at the top of a detail page (arrow + text, a real link). */
export function BackLink({ href, label = "Back", context }: { href: string; label?: string; context?: string }) {
  return (
    <Link
      href={href}
      className="mb-3 inline-flex min-h-9 items-center gap-1.5 rounded-[8px] px-1 text-[14px] font-medium text-muted hover:text-ink"
      aria-label={context ? `${label} to ${context}` : label}
    >
      <span aria-hidden="true">←</span>
      <span>{label}</span>
    </Link>
  );
}
