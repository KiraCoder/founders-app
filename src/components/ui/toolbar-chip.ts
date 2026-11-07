/** The view-chip look of ListToolbar (plain function: usable from server components too). */
export const toolbarChip = (on: boolean) =>
  `inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] border px-2.5 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
    on ? "border-line bg-surface text-ink shadow-sm" : "border-transparent text-muted hover:bg-sunk hover:text-ink"
  }`;
