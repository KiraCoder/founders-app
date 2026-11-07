"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Small toasts ("Saved · Elmurat gets an updated message", "Couldn't save: …"). A provider owns the
 * live region; components call `useToast()`. `ToastScope` adds a provider only when there is none
 * above (task components are used on many pages).
 */
type Tone = "ok" | "risk";
interface Toast {
  id: number;
  text: string;
  tone: Tone;
}
type ToastFn = (text: string, tone?: Tone) => void;

const Ctx = createContext<ToastFn | null>(null);

export function useToast(): ToastFn {
  return useContext(Ctx) ?? noop;
}
const noop: ToastFn = () => {};

export function ToastScope({ children }: { children: ReactNode }) {
  const parent = useContext(Ctx);
  if (parent) return <>{children}</>;
  return <ToastProvider>{children}</ToastProvider>;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);
  const push = useCallback<ToastFn>(
    (text, tone = "ok") => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-2), { id, text, tone }]);
      timers.current.set(id, setTimeout(() => dismiss(id), tone === "risk" ? 8000 : 4500));
    },
    [dismiss],
  );
  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => clearTimeout(t));
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            data-testid="toast"
            role={t.tone === "risk" ? "alert" : "status"}
            className={`pointer-events-auto flex max-w-[560px] items-start gap-2 rounded-[10px] border px-3 py-2 text-[13px] shadow-card ${
              t.tone === "risk" ? "border-risk-line bg-risk-soft text-risk" : "border-line bg-surface text-ink"
            }`}
          >
            <span aria-hidden="true">{t.tone === "risk" ? "⚠️" : "✓"}</span>
            <span className="min-w-0 flex-1">{t.text}</span>
            <button type="button" className="text-muted hover:text-ink" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
