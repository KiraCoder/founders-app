import Link from "next/link";
import type { ReactNode } from "react";
import { personInitials } from "@/lib/org";

export function PageHeader({
  eyebrow,
  title,
  actions,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
        <h1 className="truncate text-[22px] font-semibold leading-7">{title}</h1>
        {children}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export type Tone = "ok" | "warn" | "risk" | "info" | "neutral";

export function Tag({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`tag ${tone === "neutral" ? "" : `tag-${tone}`}`} title={title}>
      {children}
    </span>
  );
}

export function CompanyDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: color }}
    />
  );
}

export function Section({
  title,
  count,
  tone,
  action,
  children,
}: {
  title: string;
  count?: number;
  tone?: Tone;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="eyebrow">{title}</h2>
        {count !== undefined && (
          <Tag tone={count > 0 ? tone ?? "neutral" : "neutral"}>
            <span className="num">{count}</span>
          </Tag>
        )}
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  if (children) {
    return <div className="card px-4 py-6 text-center text-[13px] text-muted">{children}</div>;
  }
  return (
    <div className="card flex flex-col items-center justify-center px-4 py-8 text-center">
      {icon && <div className="mb-2 text-muted">{icon}</div>}
      {title && <h3 className="text-[14px] font-semibold text-ink">{title}</h3>}
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Computes 1-2 character uppercase initials from a name (works for Latin and Cyrillic).
 */
export function getInitials(name: string): string {
  // One rule for initials across the app (the org board uses personInitials too); empty → "".
  return name.trim() ? personInitials(name) : "";
}

/**
 * Avatar displaying initials with Founder Cockpit design tokens.
 */
export function InitialsAvatar({
  name,
  size = 28,
  tone = "accent",
  className = "",
}: {
  name: string;
  size?: number;
  tone?: "accent" | "neutral" | "sunk";
  className?: string;
}) {
  const initials = getInitials(name);
  const toneClasses = {
    accent: "bg-accent-soft text-accent border border-accent/20",
    neutral: "bg-sunk text-ink border border-line",
    sunk: "bg-sunk text-muted border border-line",
  }[tone];

  return (
    <span
      aria-hidden="true"
      className={`inline-grid shrink-0 place-items-center rounded-full font-semibold select-none ${toneClasses} ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.42)),
      }}
    >
      {initials}
    </span>
  );
}

/**
 * Status indicator dot with optional pulsing animation for live/active states.
 */
export function StatusDot({
  tone = "ok",
  pulse = false,
  size = 8,
}: {
  tone?: "ok" | "warn" | "risk" | "info" | "neutral";
  pulse?: boolean;
  size?: number;
}) {
  const toneBg = {
    ok: "bg-accent",
    warn: "bg-warn",
    risk: "bg-risk",
    info: "bg-info",
    neutral: "bg-muted",
  }[tone];

  return (
    <span className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      {pulse && (
        <span
          className={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping ${toneBg}`}
        />
      )}
      <span className={`relative inline-block rounded-full ${toneBg}`} style={{ width: size, height: size }} />
    </span>
  );
}

/**
 * Subtle pulse skeleton for loading UI placeholders.
 */
export function Skeleton({
  className = "",
  width,
  height,
}: {
  className?: string;
  width?: string | number;
  height?: string | number;
}) {
  return (
    <span
      className={`inline-block animate-pulse rounded bg-sunk ${className}`}
      style={{
        width: width !== undefined ? width : undefined,
        height: height !== undefined ? height : undefined,
      }}
    />
  );
}

export function ComingSoon({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Tag tone="info">Coming in a later chunk</Tag>
      <h2 className="text-[16px] font-semibold">{title}</h2>
      {children && <p className="max-w-md text-[13px] text-muted">{children}</p>}
    </div>
  );
}

export function TabNav({ tabs, active }: { tabs: { key: string; label: string; href: string }[]; active: string }) {
  return (
    <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-line" aria-label="Tabs">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium ${
            t.key === active ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
