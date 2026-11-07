"use client";

/**
 * Menu — a searchable popover list for inline property changes (Linear style):
 *
 *   <Menu label="Change status" options={STATUS_MENU} value={task.status} onSelect={(v) => …}
 *     trigger={(p) => <button {...p}><StatusIcon status={task.status} /></button>} />
 *
 * - Opens under (or above, near the bottom) its trigger, in a portal (never clipped by a row).
 * - Keyboard: typing filters, ↑ ↓ move, Enter picks, Esc closes and gives focus back. Number
 *   keys 1–9 pick the n-th option when the search box is empty (like Linear's shortcuts).
 * - `multiple`: options are checkboxes; the menu stays open while ticking.
 * - `onCreate`: offers "Create “…”" for a search text that matches nothing (new labels).
 * - Accessible: the trigger has aria-haspopup / aria-expanded; the list is a listbox of options
 *   (aria-selected), named by `label`.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuOption {
  value: string;
  label: string;
  icon?: ReactNode;
  /** Shown on the right (a count, a shortcut, "me"). */
  hint?: ReactNode;
  /** Extra words that match the search. */
  keywords?: string;
  /** A heading above this option (groups: "Founders", "Team"). */
  group?: string;
  disabled?: boolean;
}

export interface TriggerProps {
  ref: (el: HTMLElement | null) => void;
  onClick: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  "aria-haspopup": "listbox";
  "aria-expanded": boolean;
  "aria-label": string;
  title: string;
}

export interface MenuProps {
  /** Accessible name of the trigger and the list ("Change status"). */
  label: string;
  /** Visible name (title tooltip) of the trigger; defaults to `label`. */
  title?: string;
  options: readonly MenuOption[];
  value: string | readonly string[] | null;
  multiple?: boolean;
  onSelect: (value: string) => void;
  onCreate?: (text: string) => void;
  createLabel?: (text: string) => string;
  trigger: (props: TriggerProps) => ReactNode;
  /** Shown above the options (e.g. a date input). */
  header?: ReactNode | ((close: () => void) => ReactNode);
  /** Search box (default: on when there are more than 6 options or onCreate is set). */
  searchable?: boolean;
  placeholder?: string;
  width?: number;
  /** Called when it closes (after a pick or Esc / outside click). */
  onClose?: () => void;
  disabled?: boolean;
  /** Opens as soon as it is mounted (a filter just picked from the Filter menu). */
  autoOpen?: boolean;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/ё/g, "е");

export function Menu(props: MenuProps) {
  const { label, title, options, value, multiple, onSelect, onCreate, createLabel, trigger, header, placeholder, width = 248, onClose, disabled } = props;
  const searchable = props.searchable ?? (options.length > 6 || !!onCreate);
  const [open, setOpen] = useState(!!props.autoOpen);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const triggerEl = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = useMemo(() => new Set(value === null ? [] : typeof value === "string" ? [value] : value), [value]);
  const shown = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return options;
    return options.filter((o) => norm(`${o.label} ${o.keywords ?? ""}`).includes(q));
  }, [options, query]);
  const canCreate = !!onCreate && query.trim().length > 0 && !options.some((o) => norm(o.label) === norm(query.trim()));
  const count = shown.length + (canCreate ? 1 : 0);

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      setQuery("");
      onClose?.();
      if (refocus) triggerEl.current?.focus();
    },
    [onClose],
  );

  const place = useCallback(() => {
    const el = triggerEl.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const wanted = 340;
    if (below >= Math.min(wanted, 220) || below >= above) setPos({ top: r.bottom + 4, left, maxHeight: Math.max(160, Math.min(wanted, below)) });
    else {
      const h = Math.min(wanted, above);
      setPos({ top: Math.max(8, r.top - 4 - h), left, maxHeight: h });
    }
  }, [width]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => place();
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const first = options.findIndex((o) => selected.has(o.value));
    setActive(first >= 0 ? first : 0);
    // Focus the search box (or the list) once it is placed.
    const id = requestAnimationFrame(() => (searchable ? input.current : panel.current)?.focus());
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || triggerEl.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const pick = (i: number) => {
    if (i < shown.length) {
      const o = shown[i]!;
      if (o.disabled) return;
      onSelect(o.value);
      if (!multiple) close();
    } else if (canCreate) {
      onCreate!(query.trim());
      setQuery("");
      if (!multiple) close();
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (count ? (a + 1) % count : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (count ? (a - 1 + count) % count : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Tab") {
      close(false);
    } else if (!query && /^[1-9]$/.test(e.key) && Number(e.key) <= shown.length && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      pick(Number(e.key) - 1);
    }
  };

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const triggerProps: TriggerProps = {
    ref: (el) => {
      triggerEl.current = el;
    },
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      if (open) close();
      else setOpen(true);
    },
    onKeyDown: (e) => {
      if (disabled) return;
      if (e.key === "ArrowDown" && !open) {
        e.preventDefault();
        setOpen(true);
      }
    },
    "aria-haspopup": "listbox",
    "aria-expanded": open,
    "aria-label": label,
    title: title ?? label,
  };

  let lastGroup: string | undefined;
  return (
    <>
      {trigger(triggerProps)}
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            tabIndex={-1}
            onKeyDown={onKey}
            onClick={(e) => e.stopPropagation()}
            className="card-raised fixed z-[70] flex flex-col overflow-hidden text-[13px] outline-none"
            style={{ top: pos.top, left: pos.left, width: Math.min(width, window.innerWidth - 16), maxHeight: pos.maxHeight }}
            data-testid="menu"
          >
            {searchable && (
              <input
                ref={input}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder ?? `${label}…`}
                aria-label={`Search: ${label}`}
                aria-controls={listId}
                aria-activedescendant={count ? `${listId}-${active}` : undefined}
                className="w-full shrink-0 border-b border-line bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted"
              />
            )}
            {header && <div className="shrink-0 border-b border-line p-2">{typeof header === "function" ? header(() => close()) : header}</div>}
            <ul id={listId} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="min-h-0 flex-1 overflow-y-auto p-1">
              {shown.map((o, i) => {
                const on = selected.has(o.value);
                const heading = o.group && o.group !== lastGroup ? o.group : null;
                lastGroup = o.group;
                return (
                  <li key={o.value} role="presentation">
                    {heading && <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{heading}</div>}
                    <div
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={on}
                      aria-disabled={o.disabled || undefined}
                      data-index={i}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(i)}
                      className={`flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1 ${i === active ? "bg-sunk" : ""} ${o.disabled ? "cursor-default opacity-50" : ""}`}
                    >
                      {multiple && (
                        <span
                          aria-hidden="true"
                          className={`grid size-3.5 shrink-0 place-items-center rounded-[4px] border ${on ? "border-accent bg-accent text-accent-ink" : "border-line"}`}
                        >
                          {on && (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                              <path d="M2 5.2l2 2 4-4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </span>
                      )}
                      {o.icon && <span className="inline-flex w-4 shrink-0 justify-center">{o.icon}</span>}
                      <span className="min-w-0 flex-1 truncate">{o.label}</span>
                      {o.hint !== undefined && <span className="shrink-0 text-[12px] text-muted">{o.hint}</span>}
                      {!multiple && on && (
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0 text-accent">
                          <path d="M2.5 6.3l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  </li>
                );
              })}
              {canCreate && (
                <li role="presentation">
                  <div
                    id={`${listId}-${shown.length}`}
                    role="option"
                    aria-selected={false}
                    data-index={shown.length}
                    onMouseEnter={() => setActive(shown.length)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(shown.length)}
                    className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 text-accent ${active === shown.length ? "bg-sunk" : ""}`}
                  >
                    <span aria-hidden="true">+</span>
                    <span className="truncate">{createLabel ? createLabel(query.trim()) : `Create “${query.trim()}”`}</span>
                  </div>
                </li>
              )}
              {count === 0 && <li className="px-2 py-2 text-muted">No matches</li>}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
