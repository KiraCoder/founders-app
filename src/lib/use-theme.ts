"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "fc-theme";
/** Fired on window when this tab changes the theme, so every toggle on the page stays in sync. */
const CHANGE_EVENT = "fc-theme-change";

function isTheme(v: unknown): v is Theme {
  return v === "system" || v === "light" || v === "dark";
}

/** The saved theme; "system" when nothing (or garbage) is saved or storage is blocked. */
function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : "system";
  } catch {
    return "system"; // private mode / blocked site data
  }
}

function storeTheme(theme: Theme) {
  try {
    if (theme === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not saved (storage blocked) — the choice still applies to this page.
  }
}

/** Same rule as the inline script in the root layout: only "light" / "dark" force a theme. */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/**
 * Hook that manages the app's light / dark / system theme.
 * Reads from and persists to localStorage under "fc-theme"; stays in sync with other
 * toggles on the page and with other tabs.
 */
export function useTheme() {
  // "system" on the server and on the first client render (no hydration mismatch);
  // the stored value is read after mount.
  const [theme, setThemeState] = useState<Theme>("system");

  useEffect(() => {
    const sync = () => {
      const stored = getStoredTheme();
      setThemeState(stored);
      applyTheme(stored);
    };
    sync();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === STORAGE_KEY) sync();
    };
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<unknown>).detail;
      if (isTheme(next)) setThemeState(next);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    storeTheme(next);
    applyTheme(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }, []);

  return { theme, setTheme } as const;
}
