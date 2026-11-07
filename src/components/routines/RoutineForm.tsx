"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import type { RoutineFormState } from "@/app/(app)/routines/actions";
import { DateInput } from "@/components/DateInput";
import { ChecklistEditor, type ChecklistDraftItem } from "@/components/ui/ChecklistEditor";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Segmented } from "@/components/ui/Segmented";
import { toast } from "@/components/ui/Toast";
import { isHmTime } from "@/lib/dates";
import { describeRoutinePlan, MAX_ASK_TIMES, WEEKDAYS_EN, type ReminderMode, type RoutineChase, type RoutineSchedule } from "@/lib/routines";
import type { EscalationMode, RoutineFormOptions, RoutineFormValues, RoutineTodayRun } from "./form-values";

function FieldError({ errors, name }: { errors?: Record<string, string[]>; name: string | string[] }) {
  const names = Array.isArray(name) ? name : [name];
  const e = names.map((n) => errors?.[n]?.[0]).find(Boolean);
  return e ? <span className="text-[12px] text-risk">{e}</span> : null;
}

const hoursOf = (minutes: number) => String(Math.round((minutes / 60) * 100) / 100);
const minutesOf = (hours: string) => Math.round(Number(hours.replace(",", ".")) * 60);

/**
 * Create / edit a routine (founders), shown in a dialog. Every timing is a clear choice:
 * ask times (chips), Reminders (ask once / every N h until HH:MM / N times), Escalation (off / by
 * HH:MM tell the founders picked / after N reminders), optional start and end dates. A field left
 * at its default is sent blank so the routine keeps following the defaults (person ← global).
 * A live sentence under the form says what will happen. Editing the checklist while today's run
 * exists asks first what should happen to today's run.
 */
export function RoutineForm({
  action,
  initial,
  options,
  submitLabel,
  today = null,
  onDone,
  onCancel,
}: {
  action: (prev: RoutineFormState, fd: FormData) => Promise<RoutineFormState>;
  initial: RoutineFormValues;
  options: RoutineFormOptions;
  submitLabel: string;
  /** Today's run of the routine being edited (null: none / a new routine). */
  today?: RoutineTodayRun | null;
  onDone?: (state: RoutineFormState) => void;
  onCancel?: () => void;
}) {
  const [state, formAction, pending] = useActionState<RoutineFormState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  const applyRef = useRef<HTMLInputElement>(null);
  const confirmedRef = useRef(false);
  const [confirm, setConfirm] = useState<null | "open" | "done">(null);

  const [assignee, setAssignee] = useState(initial.assignee);
  const [companyId, setCompanyId] = useState(initial.companyId);
  const [kind, setKind] = useState(initial.scheduleKind);
  const [days, setDays] = useState<number[]>(initial.days);
  const [monthDay, setMonthDay] = useState(initial.monthDay);
  const [times, setTimes] = useState<string[]>(initial.times.length ? initial.times : ["10:00"]);
  const [newTime, setNewTime] = useState<string | null>(null);
  const [startsOn, setStartsOn] = useState(initial.startsOn);
  const [endsOn, setEndsOn] = useState(initial.endsOn);
  const [confirmation, setConfirmation] = useState(initial.confirmation);
  const [items, setItems] = useState<ChecklistDraftItem[]>(initial.items);

  const forFounder = assignee.startsWith("user:");
  const person = assignee.startsWith("person:") ? options.people.find((p) => p.id === assignee.slice(7)) : undefined;
  const founder = forFounder ? options.founders.find((f) => f.id === assignee.slice(5)) : undefined;
  const defaultsFor = (a: string): RoutineChase =>
    a.startsWith("user:") ? options.founderDefaults : (options.people.find((p) => p.id === a.slice(7))?.defaults ?? options.defaults);
  const d = defaultsFor(assignee);
  const o = initial.chase;
  const start = (c: RoutineChase) => ({
    mode: (o.reminderMode ?? c.reminderMode) as ReminderMode,
    every: hoursOf(o.chaseEveryMinutes ?? c.chaseEveryMinutes),
    until: o.chaseUntil ?? c.chaseUntil,
    remindTimes: String(o.remindTimes ?? c.remindTimes),
    esc: ((o.escalateAt === undefined ? c.escalateAt : o.escalateAt) ? "at" : (o.escalateAfterChases ?? c.escalateAfterChases) > 0 ? "after" : "off") as EscalationMode,
    escAt: (o.escalateAt === undefined ? c.escalateAt : o.escalateAt) ?? c.chaseUntil,
    escAfter: String((o.escalateAfterChases ?? c.escalateAfterChases) || 3),
    escTo: o.escalateTo ?? [],
    maxPerDay: o.maxPerDay !== undefined ? String(o.maxPerDay) : "",
  });
  const [chase, setChase] = useState(() => start(d));
  const set = (patch: Partial<typeof chase>) => setChase((c) => ({ ...c, ...patch }));

  const allowed = useMemo(() => {
    if (forFounder || !person || !person.companyIds.length) return options.companies;
    return options.companies.filter((c) => person.companyIds.includes(c.id));
  }, [forFounder, person, options.companies]);

  const pickAssignee = (a: string) => {
    const wasFounder = assignee.startsWith("user:");
    setAssignee(a);
    // A new routine follows the defaults of whoever does it (a founder: the ask + one reminder).
    if (!initial.id && a && a.startsWith("user:") !== wasFounder) setChase(start(defaultsFor(a)));
    const p = a.startsWith("person:") ? options.people.find((x) => x.id === a.slice(7)) : undefined;
    const list = !p || !p.companyIds.length ? options.companies : options.companies.filter((c) => p.companyIds.includes(c.id));
    if (p && list.length === 1) setCompanyId(list[0]!.id);
    else if (companyId && !list.some((c) => c.id === companyId)) setCompanyId("");
  };

  const addTime = () => {
    if (!newTime || !isHmTime(newTime)) return;
    if (!times.includes(newTime)) setTimes([...times, newTime].sort());
    setNewTime(null);
  };

  // A field equal to its default is sent blank (the routine keeps following the default),
  // unless the routine already had its own value for it.
  const ov = (value: string, def: string, had: unknown) => (had !== undefined || value !== def ? value : "");
  const everyMinutes = minutesOf(chase.every);
  const effective: RoutineChase = {
    reminderMode: chase.mode,
    remindTimes: Number(chase.remindTimes) || 1,
    chaseEveryMinutes: Number.isFinite(everyMinutes) && everyMinutes > 0 ? everyMinutes : d.chaseEveryMinutes,
    chaseUntil: isHmTime(chase.until) ? chase.until : d.chaseUntil,
    escalateAt: chase.esc === "at" ? chase.escAt : null,
    escalateAfterChases: chase.esc === "after" ? Number(chase.escAfter) || 0 : 0,
    escalateTo: chase.escTo,
    maxPerDay: Number(chase.maxPerDay) || d.maxPerDay,
  };
  const escalateNames = (() => {
    const pool = chase.escTo.length
      ? options.founders.filter((f) => chase.escTo.includes(f.id))
      : forFounder
        ? options.founders.filter((f) => f.id !== founder?.id)
        : options.founders;
    if (!pool.length) return "nobody";
    return pool.length === 2 && options.founders.length === 2 ? "both founders" : pool.map((f) => f.name).join(" and ");
  })();
  const schedule: RoutineSchedule =
    kind === "monthly" ? { kind: "monthly", monthDay: Number(monthDay) || 1, time: times[0] ?? "10:00", times } : { kind: "weekly", days, time: times[0] ?? "10:00", times };
  const summary =
    assignee && times.length && (kind === "monthly" ? !!monthDay : days.length > 0)
      ? describeRoutinePlan({
          assigneeName: person?.name ?? founder?.name ?? "",
          forFounder,
          schedule,
          chase: effective,
          escalateNames,
          startsOn: startsOn || null,
          endsOn: endsOn || null,
        })
      : "Pick who does it, the days and at least one time to see what the bot will do.";

  // Editing the checklist while today's run exists: say first what happens to today's run.
  const itemsChanged =
    !!initial.id &&
    JSON.stringify(initial.items.map((i) => [i.key, i.label.trim(), i.details ?? "", !!i.needsComment])) !==
      JSON.stringify((confirmation === "checklist" ? items : []).map((i) => [i.key, i.label.trim(), i.details ?? "", !!i.needsComment]));
  const added = items.filter((i) => !i.key || !today?.itemKeys.includes(i.key)).length;
  const needsConfirm: null | "open" | "done" =
    !itemsChanged || !today ? null : today.status === "open" || today.status === "escalated" ? "open" : today.status === "done" && confirmation === "checklist" && added > 0 ? "done" : null;

  useEffect(() => {
    if (!state.nonce) return;
    confirmedRef.current = false;
    if (state.ok) {
      toast(state.message ?? "Saved");
      onDone?.(state);
    } else if (state.error) toast(state.error, { tone: "risk" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nonce]);

  const submitConfirmed = (applyToToday: boolean) => {
    confirmedRef.current = true;
    if (applyRef.current) applyRef.current.value = applyToToday ? "1" : "";
    setConfirm(null);
    formRef.current?.requestSubmit();
  };

  const fe = state.fieldErrors;
  const name = person?.name ?? founder?.name ?? "the person";
  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={(e) => {
        if (needsConfirm && !confirmedRef.current) {
          e.preventDefault();
          setConfirm(needsConfirm);
        }
      }}
      className={`flex flex-col gap-4 ${pending ? "opacity-60" : ""}`}
      aria-label="Routine"
      noValidate
    >
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <input ref={applyRef} type="hidden" name="applyToToday" defaultValue="" />
      <label className="flex flex-col gap-1">
        <span className="label">Title</span>
        <input className="input" name="title" defaultValue={initial.title} required maxLength={200} aria-invalid={!!fe?.title} />
        <FieldError errors={fe} name="title" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Description (sent with the message; Russian for staff)</span>
        <textarea className="input min-h-[56px]" name="description" defaultValue={initial.description} maxLength={2000} />
      </label>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="label">Who does it</span>
          <select className="input" name="assignee" value={assignee} required onChange={(e) => pickAssignee(e.target.value)} aria-invalid={!!fe?.assignee}>
            <option value="">Pick a person or a founder…</option>
            <optgroup label="People (via Telegram)">
              {options.people.map((p) => (
                <option key={p.id} value={`person:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Founders">
              {options.founders.map((f) => (
                <option key={f.id} value={`user:${f.id}`}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          </select>
          <FieldError errors={fe} name="assignee" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Company</span>
          <select className="input" name="companyId" value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-invalid={!!fe?.companyId}>
            <option value="">Group-wide (no single company)</option>
            {allowed.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {person && !forFounder && (
            <span className="text-[12px] text-muted">
              {person.companyIds.length ? `Only the companies ${person.name} works for.` : `${person.name} has no company link in People: any company.`}
            </span>
          )}
          <FieldError errors={fe} name="companyId" />
        </label>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="label mb-1">When (Asia/Bishkek)</legend>
        <Segmented
          label="Schedule"
          hideLabel
          name="scheduleKind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "weekly", label: "Days of the week" },
            { value: "monthly", label: "Once a month" },
          ]}
        />
        {kind === "weekly" ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap gap-1.5 text-[13px]" role="group" aria-label="Days">
              {WEEKDAYS_EN.map((w, i) => (
                <label
                  key={w}
                  className={`flex cursor-pointer items-center gap-1 rounded-[var(--radius-btn)] border px-2 py-1 ${days.includes(i + 1) ? "border-accent bg-accent-soft" : "border-line"}`}
                >
                  <input
                    type="checkbox"
                    name="days"
                    value={i + 1}
                    checked={days.includes(i + 1)}
                    onChange={(e) => setDays(e.target.checked ? [...days, i + 1].sort() : days.filter((x) => x !== i + 1))}
                  />{" "}
                  {w}
                </label>
              ))}
            </div>
            <FieldError errors={fe} name="days" />
          </div>
        ) : (
          <label className="flex max-w-[220px] flex-col gap-1">
            <span className="label">Day of the month (31 = last day)</span>
            <input className="input" name="monthDay" type="number" min={1} max={31} value={monthDay} onChange={(e) => setMonthDay(e.target.value)} />
            <FieldError errors={fe} name="monthDay" />
          </label>
        )}
        <div className="flex flex-col gap-1">
          <span className="label mb-0" id="ask-at-label">
            Ask at
          </span>
          <div className="flex flex-wrap items-center gap-1.5" role="list" aria-labelledby="ask-at-label">
            {times.map((tm) => (
              <span key={tm} role="listitem" className="num inline-flex items-center gap-1 rounded-full border border-line bg-sunk py-0.5 pl-2.5 pr-1 text-[13px]">
                {tm}
                <input type="hidden" name="times" value={tm} />
                <button
                  type="button"
                  aria-label={`Remove ${tm}`}
                  title={`Remove ${tm}`}
                  disabled={times.length === 1}
                  className="rounded-full px-1 text-muted hover:text-risk disabled:opacity-30"
                  onClick={() => setTimes(times.filter((x) => x !== tm))}
                >
                  ×
                </button>
              </span>
            ))}
            {newTime === null ? (
              times.length < MAX_ASK_TIMES && (
                <button type="button" className="btn btn-sm btn-ghost text-accent" onClick={() => setNewTime("16:00")}>
                  + add time
                </button>
              )
            ) : (
              <span className="inline-flex items-center gap-1">
                <input
                  className="input h-8 w-[110px]"
                  type="time"
                  aria-label="New ask time"
                  value={newTime}
                  autoFocus
                  onChange={(e) => setNewTime(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTime();
                    }
                    if (e.key === "Escape") setNewTime(null);
                  }}
                />
                <button type="button" className="btn btn-sm" onClick={addTime}>
                  Add
                </button>
              </span>
            )}
          </div>
          <span className="text-[12px] text-muted">
            {times.length > 1 ? "One run a day: each later ask re-asks only what is not done yet." : "Add a second time to ask again later the same day about what is still open."}
          </span>
          <FieldError errors={fe} name={["times", "time"]} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="label">Starts on (optional)</span>
            <DateInput name="startsOn" value={startsOn} onChange={setStartsOn} aria-label="Starts on" />
            <FieldError errors={fe} name="startsOn" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Ends on (optional)</span>
            <DateInput name="endsOn" value={endsOn} onChange={setEndsOn} aria-label="Ends on" />
            <FieldError errors={fe} name="endsOn" />
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="label mb-1">Confirmation</legend>
        <Segmented
          label="Confirmation"
          hideLabel
          name="confirmation"
          value={confirmation}
          onChange={setConfirmation}
          options={[
            { value: "button", label: "One button (Готово)" },
            { value: "checklist", label: "Checklist" },
          ]}
        />
        {confirmation === "checklist" && (
          <ChecklistEditor name="items" value={items} onChange={setItems} error={fe?.items?.[0]} />
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line p-3">
        <legend className="label px-1">Reminders and escalation</legend>
        <input type="hidden" name="reminderMode" value={ov(chase.mode, d.reminderMode, o.reminderMode)} />
        <Segmented
          label="Reminders"
          value={chase.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: "once", label: "Ask once" },
            { value: "every", label: "Remind every … until …" },
            { value: "times", label: "Remind N times" },
          ]}
        />
        {chase.mode !== "once" && (
          <div className="flex flex-wrap items-end gap-2 text-[13px]">
            {chase.mode === "times" && (
              <label className="flex flex-col gap-1">
                <span className="label">How many reminders</span>
                <input className="input w-[90px]" inputMode="numeric" aria-label="How many reminders" value={chase.remindTimes} onChange={(e) => set({ remindTimes: e.target.value })} />
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className="label">{chase.mode === "times" ? "Apart (hours)" : "Every (hours)"}</span>
              <input className="input w-[90px]" inputMode="decimal" aria-label="Remind every (hours)" value={chase.every} onChange={(e) => set({ every: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="label">{chase.mode === "times" ? "Not after" : "Until"}</span>
              <input className="input w-[110px]" type="time" aria-label="Remind until" value={chase.until} onChange={(e) => set({ until: e.target.value })} />
            </label>
          </div>
        )}
        <input type="hidden" name="remindTimes" value={chase.mode === "times" ? ov(chase.remindTimes, String(d.remindTimes), o.remindTimes) : ""} />
        <input
          type="hidden"
          name="chaseEveryMinutes"
          value={chase.mode === "once" ? (o.chaseEveryMinutes !== undefined ? String(o.chaseEveryMinutes) : "") : ov(String(effective.chaseEveryMinutes), String(d.chaseEveryMinutes), o.chaseEveryMinutes)}
        />
        <input type="hidden" name="chaseUntil" value={chase.mode === "once" ? (o.chaseUntil ?? "") : ov(chase.until, d.chaseUntil, o.chaseUntil)} />
        <FieldError errors={fe} name={["chase.chaseEveryMinutes", "chase.chaseUntil", "chase.remindTimes", "chase.reminderMode"]} />

        <Segmented
          label="Escalation"
          value={chase.esc}
          onChange={(esc) => set({ esc })}
          options={[
            { value: "off", label: "Off" },
            { value: "at", label: "If not done by … tell founders" },
            { value: "after", label: "After N reminders" },
          ]}
        />
        <input type="hidden" name="escalateAt" value={ov(chase.esc === "at" ? chase.escAt : "off", d.escalateAt ?? "off", o.escalateAt)} />
        <input type="hidden" name="escalateAfterChases" value={ov(chase.esc === "after" ? chase.escAfter : "0", String(d.escalateAfterChases), o.escalateAfterChases)} />
        {chase.esc !== "off" && (
          <div className="flex flex-wrap items-end gap-3 text-[13px]">
            {chase.esc === "at" ? (
              <label className="flex flex-col gap-1">
                <span className="label">Not done by</span>
                <input className="input w-[110px]" type="time" aria-label="Not done by" value={chase.escAt} onChange={(e) => set({ escAt: e.target.value })} />
              </label>
            ) : (
              <label className="flex flex-col gap-1">
                <span className="label">After reminders</span>
                <input className="input w-[90px]" inputMode="numeric" aria-label="After reminders" value={chase.escAfter} onChange={(e) => set({ escAfter: e.target.value })} />
              </label>
            )}
            <div className="flex flex-col gap-1" role="group" aria-label="Tell">
              <span className="label mb-0">Tell</span>
              <div className="flex flex-wrap gap-3 py-1.5">
                {options.founders
                  .filter((f) => !forFounder || f.id !== founder?.id || chase.escTo.includes(f.id))
                  .map((f) => (
                    <label key={f.id} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        name="escalateTo"
                        value={f.id}
                        checked={chase.escTo.includes(f.id)}
                        onChange={(e) => set({ escTo: e.target.checked ? [...chase.escTo, f.id] : chase.escTo.filter((x) => x !== f.id) })}
                      />
                      {f.name}
                    </label>
                  ))}
                <span className="text-[12px] text-muted">{chase.escTo.length ? "" : forFounder ? "(none ticked = the other founder)" : "(none ticked = both)"}</span>
              </div>
            </div>
          </div>
        )}
        <FieldError errors={fe} name={["chase.escalateAt", "chase.escalateAfterChases", "chase.escalateTo"]} />
        <details className="text-[13px]">
          <summary className="cursor-pointer text-muted">More: max messages per day</summary>
          <label className="mt-2 flex max-w-[220px] flex-col gap-1">
            <span className="label">Max messages per day</span>
            <input className="input" name="maxPerDay" inputMode="numeric" value={chase.maxPerDay} placeholder={`default ${d.maxPerDay}`} onChange={(e) => set({ maxPerDay: e.target.value })} />
            <FieldError errors={fe} name="chase.maxPerDay" />
          </label>
        </details>
      </fieldset>

      <p className="rounded-[var(--radius-btn)] bg-accent-soft px-3 py-2 text-[13px] leading-relaxed" aria-live="polite" data-testid="routine-summary">
        {summary}
        {forFounder && <span className="block text-[12px] text-muted">A founder&apos;s routine arrives through their own channel and rules (quiet hours; folded into the summary when the day&apos;s pushes are used up).</span>}
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {state.error && (
          <p role="alert" className="mr-auto text-[12px] text-risk">
            {state.error}
          </p>
        )}
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>

      <ConfirmDialog
        open={confirm === "open"}
        title="Today's run is open"
        message={
          <>
            New items are added to today&apos;s run, removed items drop out of it (their ticks too), and {name} gets <b>one updated message</b> with the new
            checklist.
          </>
        }
        confirmLabel="Save and update today"
        onConfirm={() => submitConfirmed(false)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "done"}
        title="Today's run is already done"
        message={
          <>
            {name} finished today&apos;s checklist. The new item{added === 1 ? "" : "s"} can start with the next run, or be added to today too — that reopens
            today&apos;s run and asks {name} again.
          </>
        }
        confirmLabel="Save from the next run"
        secondary={{ label: "Add to today too", onClick: () => submitConfirmed(true) }}
        onConfirm={() => submitConfirmed(false)}
        onCancel={() => setConfirm(null)}
      />
    </form>
  );
}
