"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { logoutAction } from "@/app/(app)/actions";

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

export function TopBar({ user }: { user: { name: string; shortName: string; email: string } }) {
  const [agentOpen, setAgentOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const q = useSearchParams().get("q") ?? "";

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAgentOpen(false);
        setMenuOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur md:px-6">
        <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-accent text-[13px] font-bold text-accent-ink md:hidden">
          F
        </span>
        <form action="/search" role="search" className="relative min-w-0 flex-1 md:max-w-[420px]">
          <Icon name="search" size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            name="q"
            defaultValue={q}
            type="search"
            placeholder="Search tasks, projects, companies, people"
            aria-label="Search"
            className="input pl-8"
          />
        </form>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            className="btn btn-ghost px-2.5"
            onClick={() => setAgentOpen(true)}
            aria-expanded={agentOpen}
            aria-controls="agent-panel"
          >
            <Icon name="sparkles" />
            <span className="hidden sm:inline">Agent</span>
          </button>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              className="btn btn-ghost gap-2 px-1.5"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="User menu"
            >
              <span className="grid size-7 place-items-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">
                {initials(user.name)}
              </span>
              <span className="hidden text-[13px] lg:inline">{user.shortName}</span>
            </button>
            {menuOpen && (
              <div role="menu" className="card-raised absolute right-0 top-11 w-60 p-1.5">
                <div className="px-2.5 py-2">
                  <p className="text-[13px] font-medium">{user.name}</p>
                  <p className="text-[12px] text-muted">{user.email}</p>
                </div>
                <form action={logoutAction}>
                  <button type="submit" role="menuitem" className="btn btn-ghost w-full justify-start">
                    <Icon name="logout" size={16} /> Sign out
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      </header>

      {agentOpen && (
        <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setAgentOpen(false)} aria-hidden="true" />
      )}
      <aside
        id="agent-panel"
        aria-label="Agent panel"
        aria-hidden={!agentOpen}
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-[380px] flex-col border-l border-line bg-surface shadow-card transition-transform duration-200 ${
          agentOpen ? "translate-x-0" : "pointer-events-none translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-line px-4">
          <div className="flex items-center gap-2">
            <Icon name="sparkles" />
            <span className="font-semibold">Agent</span>
          </div>
          <button type="button" className="btn btn-ghost px-2" onClick={() => setAgentOpen(false)} aria-label="Close agent panel">
            <Icon name="close" />
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <span className="tag tag-info">Not connected</span>
          <p className="text-[15px] font-semibold">AI agents arrive after the AI provider is chosen</p>
          <p className="text-[13px] text-muted">
            Each page will have an agent you can talk to. Nuraaly picks the provider first; nothing is sent anywhere yet.
          </p>
        </div>
      </aside>
    </>
  );
}
