"use client";

/**
 * Toast — short success / failure messages after an action.
 *
 *   toast("Routine created");                    // anywhere in client code
 *   toast("Could not save: …", { tone: "risk" });
 *   <Toaster />                                  // once, in the app layout
 *
 * Toasts stack bottom-right (bottom-centre on phones, above the tab bar), each is a live region
 * (role="status", or role="alert" for "risk") and goes away after `ms` (default 5 s) or on ×.
 * Works through a window event, so no provider is needed.
 */
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";

export type ToastTone = "ok" | "risk" | "info";
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}
const EVENT = "app:toast";
let seq = 0;

export function toast(message: string, opts: { tone?: ToastTone; ms?: number } = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { message, tone: opts.tone ?? "ok", ms: opts.ms ?? 5000 } }));
}

const TONE: Record<ToastTone, string> = {
  ok: "border-accent/40 bg-surface text-ink",
  info: "border-info/40 bg-surface text-ink",
  risk: "border-risk-line bg-risk-soft text-risk",
};

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ message: string; tone: ToastTone; ms: number }>).detail;
      const id = ++seq;
      setItems((list) => [...list.slice(-3), { id, message: d.message, tone: d.tone }]);
      const timer = setTimeout(() => {
        setItems((list) => list.filter((x) => x.id !== id));
        timers.delete(timer);
      }, d.ms);
      timers.add(timer);
    };
    window.addEventListener(EVENT, on);
    return () => {
      window.removeEventListener(EVENT, on);
      for (const t of timers) clearTimeout(t);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-20 z-50 flex flex-col items-center gap-2 md:inset-x-auto md:bottom-6 md:right-6 md:items-end">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === "risk" ? "alert" : "status"}
          className={`pointer-events-auto flex max-w-[420px] items-start gap-2 rounded-[var(--radius-card)] border px-3 py-2 text-[13px] shadow-[var(--shadow)] ${TONE[t.tone]}`}
        >
          <span className="pt-0.5">{t.tone === "risk" ? "!" : <Icon name="check" size={15} className="text-accent" />}</span>
          <span className="min-w-0 flex-1">{t.message}</span>
          <button type="button" aria-label="Dismiss" className="text-muted hover:text-ink" onClick={() => setItems((list) => list.filter((x) => x.id !== t.id))}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
