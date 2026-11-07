"use client";

import { Suspense, use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { InitialsAvatar } from "@/components/ui";
import { ShortcutsModal } from "./ShortcutsModal";
import { ThemeToggle } from "@/components/settings/ThemeToggle";
import { logoutAction } from "@/app/(app)/actions";

export interface AgentHire {
  id: string;
  roleName: string;
  companySlug: string;
  companyName: string;
  status: "active" | "paused";
  latestRun: { id: string; periodLabel: string; status: string; summary: string } | null;
}

const RUN_LABEL: Record<string, string> = {
  waiting_for_data: "Waiting for data",
  ready: "Ready",
  analysed: "Analysed",
  reported: "Report ready",
  failed: "Failed",
};

/**
 * Hired AI roles in the agent panel: this company's first (on a company page), then the rest.
 * `hires` is streamed from the layout (a promise): the shell never waits for it.
 */
function AgentHires({ hires: pending, onNavigate }: { hires: Promise<AgentHire[]>; onNavigate: () => void }) {
  const hires = use(pending);
  const pathname = usePathname();
  const slug = /^\/companies\/([^/?#]+)/.exec(pathname)?.[1] ?? null;
  const here = slug ? hires.filter((h) => h.companySlug === slug) : [];
  const rest = hires.filter((h) => !here.includes(h));
  const row = (h: AgentHire) => (
    <li key={h.id} className="card px-3 py-2 text-[13px]" data-testid="agent-hire">
      <div className="flex items-center gap-2">
        <span className="font-medium">{h.roleName}</span>
        <span className="text-muted">· {h.companyName}</span>
        {h.status === "paused" && <span className="tag ml-auto">Paused</span>}
      </div>
      {h.latestRun ? (
        <Link href={`/ai-roles/runs/${h.latestRun.id}`} onClick={onNavigate} className="mt-0.5 block text-accent hover:underline">
          {h.latestRun.periodLabel}: {RUN_LABEL[h.latestRun.status] ?? h.latestRun.status} — {h.latestRun.summary}
        </Link>
      ) : (
        <p className="mt-0.5 text-muted">No report yet</p>
      )}
    </li>
  );
  return (
    <div className="flex flex-col gap-3 p-4">
      {slug && (
        <div>
          <p className="eyebrow mb-1.5">Working for this company</p>
          {here.length ? <ul className="flex flex-col gap-2">{here.map(row)}</ul> : <p className="text-[13px] text-muted">No AI role hired here yet.</p>}
        </div>
      )}
      {rest.length > 0 && (
        <div>
          <p className="eyebrow mb-1.5">{slug ? "Other hired roles" : "Hired AI roles"}</p>
          <ul className="flex flex-col gap-2">{rest.map(row)}</ul>
        </div>
      )}
      {hires.length === 0 && <p className="text-[13px] text-muted">No AI roles hired yet.</p>}
      <Link href="/ai-roles" onClick={onNavigate} className="text-[13px] text-accent hover:underline">
        Hire or tune AI roles →
      </Link>
    </div>
  );
}

const NO_HIRES: Promise<AgentHire[]> = Promise.resolve([]);

export function TopBar({ user, agentHires = NO_HIRES }: { user: { name: string; shortName: string; email: string }; agentHires?: Promise<AgentHire[]> }) {
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
            className="input pl-8 pr-10"
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 hidden select-none rounded border border-line bg-sunk px-1.5 py-0.5 text-[10px] font-medium text-muted md:inline-block">
            /
          </kbd>
        </form>
        <div className="ml-auto flex items-center gap-1.5">
          <ShortcutsModal />
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
              <InitialsAvatar name={user.name} size={28} />
              <span className="hidden text-[13px] font-medium lg:inline">{user.shortName}</span>
            </button>
            {menuOpen && (
              <div role="menu" className="card-raised absolute right-0 top-11 w-60 p-1.5">
                <div className="px-2.5 py-2">
                  <p className="text-[13px] font-medium">{user.name}</p>
                  <p className="text-[12px] text-muted">{user.email}</p>
                </div>
                <div className="border-t border-line px-2 py-2">
                  <ThemeToggle />
                </div>
                <form action={logoutAction} className="border-t border-line pt-1">
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
        <div className="flex-1 overflow-y-auto">
          <Suspense fallback={<p className="p-4 text-[13px] text-muted">Loading AI roles…</p>}>
            <AgentHires hires={agentHires} onNavigate={() => setAgentOpen(false)} />
          </Suspense>
          <div className="mx-4 mb-4 flex flex-col gap-1.5 rounded-[10px] border border-line bg-sunk p-3 text-[12px]">
            <span className="tag tag-info self-start">Chat not connected</span>
            <p className="text-muted">
              Talking to the page&apos;s agent arrives after the AI provider is chosen (Nuraaly picks it). Hired roles already run without it; nothing is sent anywhere.
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
