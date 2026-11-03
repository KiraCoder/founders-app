"use client";

import { useTheme } from "@/lib/use-theme";

const OPTIONS = [
  { value: "light" as const, label: "Light", icon: "☀️" },
  { value: "dark" as const, label: "Dark", icon: "🌙" },
  { value: "system" as const, label: "System", icon: "💻" },
];

/**
 * Three-way segmented control for light / dark / system theme.
 * Designed to match the Founder Cockpit design system.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="flex items-center gap-1 rounded-[10px] border border-line bg-sunk p-1" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={theme === o.value}
          onClick={() => setTheme(o.value)}
          className={`flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors ${
            theme === o.value
              ? "bg-surface text-ink shadow-sm border border-line"
              : "text-muted hover:text-ink border border-transparent"
          }`}
        >
          <span aria-hidden="true">{o.icon}</span>
          {o.label}
        </button>
      ))}
    </div>
  );
}
