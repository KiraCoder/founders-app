"use client";

import { useTheme } from "@/lib/use-theme";

const OPTIONS = [
  { value: "light" as const, label: "Light", icon: "☀️" },
  { value: "dark" as const, label: "Dark", icon: "🌙" },
  { value: "system" as const, label: "System", icon: "💻" },
];

/**
 * Three-way segmented control for light / dark / system theme.
 * Designed to match the Founder Cockpit design system. Toggle buttons (aria-pressed), not
 * radios: role="radio" would promise arrow-key navigation these buttons do not have.
 * Three equal columns that always fill their box (the profile menu is narrow): each button
 * shrinks (min-w-0) and centres its icon + label on one line, so "System" never spills out.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="grid w-full grid-cols-3 gap-1 rounded-[10px] border border-line bg-sunk p-1" role="group" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={theme === o.value}
          onClick={() => setTheme(o.value)}
          className={`flex min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-[7px] border px-1 py-1.5 text-[12px] font-medium leading-none transition-colors ${
            theme === o.value ? "border-line bg-surface text-ink shadow-sm" : "border-transparent text-muted hover:text-ink"
          }`}
        >
          <span aria-hidden="true" className="shrink-0 text-[11px] leading-none">
            {o.icon}
          </span>
          <span className="min-w-0 truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
