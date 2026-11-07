"use client";

/**
 * A routine row's inline menus (0034, the same interaction as a task row): the status icon opens
 * Active / Paused / Archived, the avatar opens who does it. Optimistic through the row's
 * RoutineStatusScope (status) or local state (assignee); a refusal rolls back with a toast.
 */
import { useOptimistic, useTransition } from "react";
import { setRoutineAssigneeAction, setRoutineStatusInlineAction, type RoutineFormState } from "@/app/(app)/routines/actions";
import { Icon } from "@/components/Icon";
import { InitialsAvatar } from "@/components/ui";
import { Menu, type MenuOption } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";
import type { RoutineStatus } from "@/lib/routines";
import { useRoutineStatus } from "./RoutineStatus";
import { STATUS_LABEL } from "./status";

export const ROUTINE_STATUS_COLOR: Record<string, string> = { active: "var(--accent)", paused: "var(--warn)", ended: "var(--muted)", archived: "var(--muted)" };

/** Our routine icon (↻), coloured by status. */
export function RoutineStatusIcon({ status, size = 15 }: { status: string; size?: number }) {
  return (
    <span style={{ color: ROUTINE_STATUS_COLOR[status] ?? "var(--muted)" }} className="inline-flex" aria-hidden="true">
      <Icon name={status === "paused" ? "pause" : status === "archived" ? "archive" : "repeat"} size={size} />
    </span>
  );
}

async function call(fn: () => Promise<RoutineFormState>): Promise<void> {
  let r: RoutineFormState;
  try {
    r = await fn();
  } catch {
    r = { ok: false, error: "Could not reach the server. Nothing was changed." };
  }
  if (r.ok) toast(r.message ?? "Saved", { ms: 2500 });
  else toast(r.error ?? "Could not save", { tone: "risk" });
}

export function RoutineStatusMenu({ id, status: given, title }: { id: string; status: string; title: string }) {
  const { status, setStatus } = useRoutineStatus(given);
  const [, start] = useTransition();
  const options: MenuOption[] = (["active", "paused", "archived"] as const).map((s) => ({
    value: s,
    label: s === "active" && status !== "active" ? (status === "archived" ? "Restore (Active)" : "Resume (Active)") : STATUS_LABEL[s]!,
    icon: <RoutineStatusIcon status={s} size={14} />,
  }));
  if (status === "ended") options.unshift({ value: "ended", label: "Ended (change “Ends on” to run again)", icon: <RoutineStatusIcon status="ended" size={14} />, disabled: true });
  return (
    <Menu
      label={`Change status of ${title}`}
      title={`Status: ${STATUS_LABEL[status] ?? status}`}
      options={options}
      value={status}
      searchable={false}
      width={240}
      onSelect={(v) => {
        if (v === status) return;
        start(async () => {
          setStatus(v);
          await call(() => setRoutineStatusInlineAction(id, v as RoutineStatus));
        });
      }}
      trigger={(p) => (
        <button
          type="button"
          {...p}
          ref={p.ref as (el: HTMLButtonElement | null) => void}
          data-testid="routine-status-picker"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] hover:bg-sunk focus-visible:outline-2 focus-visible:outline-accent"
        >
          <RoutineStatusIcon status={status} />
        </button>
      )}
    />
  );
}

export interface RoutineAssigneeOption {
  value: string;
  label: string;
  group: "Founders" | "Team";
  /** Companies the person works for (empty = any). */
  companyIds?: string[];
}

export function RoutineAssigneeMenu({
  id,
  title,
  assignee,
  name,
  companyId,
  options,
  disabled,
}: {
  id: string;
  title: string;
  assignee: string;
  name: string;
  companyId: string | null;
  options: RoutineAssigneeOption[];
  disabled?: boolean;
}) {
  const [shown, setShown] = useOptimistic({ assignee, name }, (_s, next: { assignee: string; name: string }) => next);
  const [, start] = useTransition();
  const list: MenuOption[] = options
    .filter((o) => o.group === "Founders" || !companyId || !o.companyIds?.length || o.companyIds.includes(companyId))
    .map((o) => ({ value: o.value, label: o.label, group: o.group, icon: <InitialsAvatar name={o.label} size="xs" tone={o.group === "Team" ? "neutral" : "accent"} /> }));
  return (
    <Menu
      label={`Change who does ${title}`}
      title={`Assignee: ${shown.name}`}
      options={list}
      value={shown.assignee}
      searchable
      disabled={disabled}
      onSelect={(v) => {
        if (v === shown.assignee) return;
        const label = options.find((o) => o.value === v)?.label ?? "?";
        start(async () => {
          setShown({ assignee: v, name: label });
          await call(() => setRoutineAssigneeAction(id, v));
        });
      }}
      trigger={(p) => (
        <button
          type="button"
          {...p}
          ref={p.ref as (el: HTMLButtonElement | null) => void}
          data-testid="routine-assignee-picker"
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full pr-1.5 text-[12px] text-muted hover:bg-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none"
        >
          <InitialsAvatar name={shown.name} size="xs" tone={shown.assignee.startsWith("person:") ? "neutral" : "accent"} />
          <span className="hidden max-w-[110px] truncate sm:inline">{shown.name}</span>
        </button>
      )}
    />
  );
}
