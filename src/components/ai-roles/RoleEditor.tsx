"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  createCustomRoleAction,
  revertHireAction,
  revertRoleAction,
  saveHireSettingsAction,
  saveRoleAction,
  type AiActionState,
} from "@/app/(app)/ai-roles/actions";
import { Icon } from "@/components/Icon";
import { CHECK_CATALOGUE, WEEKDAY_NAMES, type ChecksConfig, type RoleEngine, type Schedule } from "@/lib/ai-role-config";

export interface EditorMetric {
  key: string;
  label: string;
  granularity: "day" | "week" | "month";
  unit: string;
  payData: boolean;
}

export interface EditorRatio {
  id: string;
  enabled: boolean;
  numeratorKey: string;
  denominatorKey: string;
  percent: boolean;
  min: string | null;
  max: string | null;
}

export interface EditorIdentity {
  name: string;
  description: string;
  responsibilities: string[];
  instructions: string;
}

export interface EditorVersion {
  version: number;
  action: string;
  revertedTo: number | null;
  at: string;
  byName: string | null;
  changed: string[];
}

/** A role a custom role can be copied from (create mode). */
export interface CopySource extends EditorIdentity {
  key: string;
  schedule: Schedule;
  checks: ChecksConfig;
  /** companyId → the numbers it needs there (pay data left out). */
  keysByCompany: Record<string, string[]>;
}

export interface EditorTarget {
  mode: "role" | "hire" | "create";
  title: string;
  roleKey?: string;
  hireId?: string;
  engine: RoleEngine;
  custom: boolean;
  /** Saved own values (role: its edits; hire: its overrides). Empty = inherited. */
  identity: EditorIdentity;
  /** What an empty field means (role: the code default; hire: the role's). */
  inherited: EditorIdentity;
  schedule: Schedule;
  recipients: string[];
  askUserIds?: string[];
  checks: ChecksConfig;
  /** Hire: it has its own checks (otherwise it follows the role's). */
  ownChecks?: boolean;
  companyId?: string;
  watched?: string[];
  required?: string[];
  ratioChecks?: EditorRatio[];
  notes?: string | null;
  versions: EditorVersion[];
}

const ENGINE_FOR_CHECKS = (e: RoleEngine): RoleEngine => e;

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The AI role editor (founders): name, job description, responsibilities, your instructions,
 * schedule (monthly / weekly / off), recipients, every rule check on/off with its own
 * thresholds, the numbers a custom role watches and its ratio checks, and the version
 * history with Revert. One dialog for a role (template level), a hire (its own overrides)
 * and a new custom role.
 */
export function RoleEditor({
  target,
  founders,
  companies,
  metricsByCompany,
  copySources,
  onClose,
}: {
  target: EditorTarget;
  founders: { id: string; shortName: string }[];
  companies: { id: string; name: string }[];
  metricsByCompany: Record<string, EditorMetric[]>;
  copySources: CopySource[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<AiActionState>({});
  const creating = target.mode === "create";
  const hire = target.mode === "hire";
  const showsNumbers = target.custom || creating;
  const engine = creating ? "custom" : target.engine;
  const runRole = engine !== "org_rules";

  const [companyId, setCompanyId] = useState(target.companyId ?? "");
  const [copyFrom, setCopyFrom] = useState("");
  const [name, setName] = useState(target.identity.name);
  const [description, setDescription] = useState(target.identity.description);
  const [responsibilities, setResponsibilities] = useState(target.identity.responsibilities.join("\n"));
  const [instructions, setInstructions] = useState(target.identity.instructions);
  const [schedule, setSchedule] = useState<Schedule>(target.schedule);
  const [recipients, setRecipients] = useState<string[]>(target.recipients);
  const [askIds, setAskIds] = useState<string[]>(target.askUserIds ?? target.recipients);
  const [checks, setChecks] = useState<ChecksConfig>(structuredClone(target.checks));
  const [checksDirty, setChecksDirty] = useState(false);
  const [useRoleChecks, setUseRoleChecks] = useState(hire && !target.ownChecks);
  const [watched, setWatched] = useState<string[]>(target.watched ?? []);
  const [required, setRequired] = useState<string[]>(target.required ?? target.watched ?? []);
  const [ratios, setRatios] = useState<EditorRatio[]>(target.ratioChecks ?? []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const metrics = useMemo(() => metricsByCompany[companyId] ?? [], [metricsByCompany, companyId]);
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const pickCopy = (key: string) => {
    setCopyFrom(key);
    const src = copySources.find((c) => c.key === key);
    if (!src) return;
    setName(`${src.name} (copy)`);
    setDescription(src.description);
    setResponsibilities(src.responsibilities.join("\n"));
    setInstructions(src.instructions);
    setSchedule(src.schedule);
    const generic: ChecksConfig = {};
    for (const c of CHECK_CATALOGUE.custom) if (src.checks[c.id]) generic[c.id] = { ...src.checks[c.id]! };
    setChecks({ ...checks, ...generic });
    if (companyId) {
      const keys = src.keysByCompany[companyId] ?? [];
      setWatched(keys);
      setRequired(keys);
    }
  };
  const pickCompany = (id: string) => {
    setCompanyId(id);
    const keys = copySources.find((c) => c.key === copyFrom)?.keysByCompany[id] ?? [];
    setWatched(keys);
    setRequired(keys);
    setRatios([]);
  };

  const setParam = (checkId: string, key: string, raw: string) => {
    setChecksDirty(true);
    setUseRoleChecks(false);
    const v = raw.trim() === "" ? null : Number(raw);
    setChecks({ ...checks, [checkId]: { ...checks[checkId]!, [key]: v === null || Number.isNaN(v) ? null : v } });
  };
  const setEnabled = (checkId: string, on: boolean) => {
    setChecksDirty(true);
    setUseRoleChecks(false);
    setChecks({ ...checks, [checkId]: { ...checks[checkId]!, enabled: on } });
  };

  const problem = useMemo(() => {
    if (creating && !companyId) return "Choose a company";
    if ((creating || target.custom) && target.mode !== "hire" && name.trim().length < 2) return "Give the role a name";
    if (showsNumbers && !hire && !watched.length) return "Choose at least one number it watches";
    if (schedule.kind === "monthly" && !(schedule.day >= 1 && schedule.day <= 28)) return "Day of the month: 1 to 28";
    if (!recipients.length) return "Choose at least one founder";
    if (hire && runRole && !askIds.length) return "Choose at least one founder it asks";
    for (const r of ratios) if (!r.numeratorKey || !r.denominatorKey || (r.min === null && r.max === null)) return "Each ratio check needs two numbers and a min or max";
    return null;
  }, [creating, companyId, target.custom, target.mode, name, showsNumbers, hire, watched, schedule, recipients, askIds, runRole, ratios]);

  const profile = () => ({ name: name.trim(), description: description.trim(), responsibilities: lines(responsibilities), instructions: instructions.trim() });
  const cleanChecks = (): ChecksConfig => {
    const out: ChecksConfig = {};
    for (const def of CHECK_CATALOGUE[ENGINE_FOR_CHECKS(engine)]) if (checks[def.id]) out[def.id] = checks[def.id]!;
    return out;
  };

  const submit = () =>
    start(async () => {
      let res: AiActionState;
      const allFounders = founders.every((f) => recipients.includes(f.id));
      if (hire) {
        const prev = checks.change_prev;
        const heads = checks.head_overloaded?.maxDepartments;
        const p = profile();
        const hasProfile = p.name || p.description || p.responsibilities.length || p.instructions;
        res = await saveHireSettingsAction(target.hireId!, {
          settings: {
            schedule,
            recipients,
            askUserIds: runRole ? askIds : recipients,
            profile: hasProfile ? p : null,
            ...(useRoleChecks ? { checks: null } : checksDirty || target.ownChecks ? { checks: cleanChecks() } : {}),
            ...(prev && typeof prev.warnPct === "number" && typeof prev.riskPct === "number" ? { thresholds: { changePct: prev.warnPct, riskChangePct: prev.riskPct } } : {}),
            ...(typeof heads === "number" ? { maxDepartmentsPerHead: heads } : {}),
          },
        });
      } else {
        const config = {
          profile: profile(),
          schedule,
          ...(allFounders ? {} : { recipients }),
          checks: cleanChecks(),
          ...(showsNumbers ? { watchedMetricKeys: watched, requiredMetricKeys: required.filter((k) => watched.includes(k)), ratioChecks: ratios } : {}),
        };
        res = creating ? await createCustomRoleAction({ companyId, copyFrom: copyFrom || null, config }) : await saveRoleAction(target.roleKey!, config);
      }
      setState(res);
      if (res.ok) {
        router.refresh();
        onClose();
      }
    });

  const revert = (version: number) =>
    start(async () => {
      const res = hire ? await revertHireAction(target.hireId!, version) : await revertRoleAction(target.roleKey!, version);
      setState(res);
      if (res.ok) {
        router.refresh();
        onClose();
      }
    });

  const label = creating ? "Create your own role" : `Edit ${target.title}`;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] w-full max-w-[680px] flex-col rounded-t-[14px] border border-line bg-surface shadow-card md:inset-y-8 md:bottom-auto md:rounded-[14px]"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <p className="eyebrow">{creating ? "New role" : hire ? "This hire's settings" : target.custom ? "Your role" : "Role settings (all hires that don't override them)"}</p>
            <h2 className="text-[16px] font-semibold">{creating ? "Create your own role" : target.title}</h2>
          </div>
          <button type="button" className="btn btn-ghost px-2" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-[13px]">
          {creating && (
            <section className="grid gap-3 sm:grid-cols-2">
              <label>
                <span className="label">Company</span>
                <select className="input" value={companyId} onChange={(e) => pickCompany(e.target.value)} aria-label="Company">
                  <option value="">Choose…</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="label">Start from</span>
                <select className="input" value={copyFrom} onChange={(e) => pickCopy(e.target.value)} aria-label="Start from">
                  <option value="">Scratch</option>
                  {copySources.map((c) => (
                    <option key={c.key} value={c.key}>
                      Copy of {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          )}

          <section aria-labelledby="ed-role">
            <h3 id="ed-role" className="eyebrow mb-2">
              Role
            </h3>
            <div className="grid gap-3">
              <label>
                <span className="label">Name</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={target.inherited.name} aria-label="Role name" />
              </label>
              <label>
                <span className="label">Job description</span>
                <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={target.inherited.description} aria-label="Job description" />
              </label>
              <label>
                <span className="label">Responsibilities (one per line)</span>
                <textarea
                  className="input"
                  rows={3}
                  value={responsibilities}
                  onChange={(e) => setResponsibilities(e.target.value)}
                  placeholder={target.inherited.responsibilities.join("\n")}
                  aria-label="Responsibilities"
                />
              </label>
              <label>
                <span className="label">Your instructions</span>
                <textarea
                  className="input"
                  rows={3}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={target.inherited.instructions || "E.g. “Always compare COD with last year; keep it to three sentences.”"}
                  aria-label="Your instructions"
                />
                <span className="mt-1 block text-[12px] text-muted" data-testid="instructions-note">
                  Stored now; used after the AI provider is chosen (for the AI summary). The rule checks below never depend on it. Never put salaries here.
                </span>
              </label>
              {(hire || !creating) && <p className="text-[12px] text-muted">{hire ? "Empty fields use the role's text." : "Empty fields use the built-in text."}</p>}
            </div>
          </section>

          {showsNumbers && !hire && (
            <section aria-labelledby="ed-numbers">
              <h3 id="ed-numbers" className="eyebrow mb-2">
                Numbers it watches
              </h3>
              {!companyId ? (
                <p className="text-muted">Choose a company first.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {metrics.map((m) => (
                    <div key={m.key} className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={watched.includes(m.key)}
                          disabled={m.payData}
                          onChange={() => {
                            toggle(watched, setWatched, m.key);
                            if (!watched.includes(m.key)) setRequired([...required, m.key]);
                          }}
                          aria-label={`Watch ${m.label}`}
                        />
                        <span>{m.label}</span>
                        <span className="text-muted">
                          · {m.granularity === "day" ? "daily" : m.granularity === "week" ? "weekly" : "monthly"}, {m.unit}
                        </span>
                      </label>
                      {m.payData && <span className="tag">pay data — never watched</span>}
                      {watched.includes(m.key) && (
                        <label className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted">
                          <input type="checkbox" checked={required.includes(m.key)} onChange={() => toggle(required, setRequired, m.key)} aria-label={`Wait for ${m.label}`} />
                          waits for it
                        </label>
                      )}
                    </div>
                  ))}
                  <p className="mt-1 text-[12px] text-muted">It asks for the numbers it waits for (inside the morning summary) and analyses the month once they are in.</p>
                </div>
              )}
            </section>
          )}

          <section aria-labelledby="ed-schedule">
            <h3 id="ed-schedule" className="eyebrow mb-2">
              Schedule
            </h3>
            <div className="flex flex-wrap items-end gap-3">
              <label>
                <span className="label">How often</span>
                <select
                  className="input"
                  value={schedule.kind}
                  aria-label="Schedule"
                  onChange={(e) =>
                    setSchedule(e.target.value === "monthly" ? { kind: "monthly", day: 10 } : e.target.value === "weekly" ? { kind: "weekly", weekday: 1 } : { kind: "off" })
                  }
                >
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                  <option value="off">Off</option>
                </select>
              </label>
              {schedule.kind === "monthly" && (
                <label>
                  <span className="label">Day of the month</span>
                  <input
                    className="input w-24"
                    inputMode="numeric"
                    value={String(schedule.day)}
                    onChange={(e) => setSchedule({ kind: "monthly", day: Number(e.target.value) || 0 })}
                    aria-label="Day of the month"
                  />
                </label>
              )}
              {schedule.kind === "weekly" && (
                <label>
                  <span className="label">Weekday</span>
                  <select className="input" value={schedule.weekday} onChange={(e) => setSchedule({ kind: "weekly", weekday: Number(e.target.value) })} aria-label="Weekday">
                    {WEEKDAY_NAMES.map((d, i) => (
                      <option key={d} value={i + 1}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="mt-1 text-[12px] text-muted">
              {runRole
                ? "Monthly: the report for the finished month on that day. Weekly: on the first such weekday of the month. Off: only Run now."
                : "When its one line goes into the morning summary. Off: no line (the findings stay on the org board)."}
            </p>
          </section>

          <section aria-labelledby="ed-people">
            <h3 id="ed-people" className="eyebrow mb-2">
              Recipients
            </h3>
            <fieldset>
              <legend className="label">{runRole ? "Who gets its reports" : "Who gets its line"}</legend>
              {founders.map((f) => (
                <label key={f.id} className="mr-4 inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={recipients.includes(f.id)} onChange={() => toggle(recipients, setRecipients, f.id)} aria-label={`Reports to ${f.shortName}`} />
                  {f.shortName}
                </label>
              ))}
            </fieldset>
            {hire && runRole && (
              <fieldset className="mt-2">
                <legend className="label">Whom it asks for missing numbers</legend>
                {founders.map((f) => (
                  <label key={f.id} className="mr-4 inline-flex items-center gap-1.5">
                    <input type="checkbox" checked={askIds.includes(f.id)} onChange={() => toggle(askIds, setAskIds, f.id)} aria-label={`Asks ${f.shortName}`} />
                    {f.shortName}
                  </label>
                ))}
              </fieldset>
            )}
            <p className="mt-1 text-[12px] text-muted">Founders only — it never messages anyone else.{!hire && " New hires start with these."}</p>
          </section>

          <section aria-labelledby="ed-checks" data-testid="editor-checks">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 id="ed-checks" className="eyebrow">
                Rule checks
              </h3>
              {hire && (
                <label className="ml-auto inline-flex items-center gap-1.5 text-[12px]">
                  <input
                    type="checkbox"
                    checked={useRoleChecks}
                    onChange={(e) => {
                      setUseRoleChecks(e.target.checked);
                      if (e.target.checked) setChecks(structuredClone(target.checks));
                    }}
                    aria-label="Use the role's checks"
                  />
                  Use the role&apos;s checks
                </label>
              )}
            </div>
            <div className="flex flex-col gap-2">
              {CHECK_CATALOGUE[ENGINE_FOR_CHECKS(engine)].map((def) => {
                const c = checks[def.id] ?? { enabled: def.defaultEnabled };
                return (
                  <div key={def.id} className="rounded-[10px] border border-line px-3 py-2" data-testid={`check-${def.id}`}>
                    <label className="flex items-center gap-2 font-medium">
                      <input type="checkbox" checked={c.enabled === true} onChange={(e) => setEnabled(def.id, e.target.checked)} aria-label={def.label} />
                      {def.label}
                    </label>
                    {def.help && <p className="text-[12px] text-muted">{def.help}</p>}
                    {def.params.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-3">
                        {def.params.map((p) => (
                          <label key={p.key} className="text-[12px]">
                            <span className="text-muted">{p.label}</span>
                            <input
                              className="input mt-0.5 w-28"
                              inputMode="numeric"
                              value={typeof c[p.key] === "number" ? String(c[p.key]) : ""}
                              placeholder={p.nullLabel ?? ""}
                              onChange={(e) => setParam(def.id, p.key, e.target.value)}
                              aria-label={`${def.label}: ${p.label}`}
                              disabled={!c.enabled}
                            />
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {!hire && runRole && !creating && !target.custom && (
              <p className="mt-1 text-[12px] text-muted">The “vs the month before” thresholds are the starting values of new hires; each hire keeps its own (Tune).</p>
            )}
          </section>

          {showsNumbers && !hire && (
            <section aria-labelledby="ed-ratios">
              <h3 id="ed-ratios" className="eyebrow mb-2">
                Ratio checks
              </h3>
              <div className="flex flex-col gap-2">
                {ratios.map((r, i) => {
                  const set = (patch: Partial<EditorRatio>) => setRatios(ratios.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  const watchedMetrics = metrics.filter((m) => watched.includes(m.key));
                  return (
                    <div key={r.id} className="flex flex-wrap items-end gap-2 rounded-[10px] border border-line px-3 py-2">
                      <select className="input w-40" value={r.numeratorKey} onChange={(e) => set({ numeratorKey: e.target.value })} aria-label="Ratio numerator">
                        <option value="">Number…</option>
                        {watchedMetrics.map((m) => (
                          <option key={m.key} value={m.key}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      <span>/</span>
                      <select className="input w-40" value={r.denominatorKey} onChange={(e) => set({ denominatorKey: e.target.value })} aria-label="Ratio denominator">
                        <option value="">Number…</option>
                        {watchedMetrics.map((m) => (
                          <option key={m.key} value={m.key}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      <label className="inline-flex items-center gap-1 text-[12px]">
                        <input type="checkbox" checked={r.percent} onChange={(e) => set({ percent: e.target.checked })} /> as %
                      </label>
                      <input className="input w-24" placeholder="min" value={r.min ?? ""} onChange={(e) => set({ min: e.target.value.trim() || null })} aria-label="Ratio minimum" />
                      <input className="input w-24" placeholder="max" value={r.max ?? ""} onChange={(e) => set({ max: e.target.value.trim() || null })} aria-label="Ratio maximum" />
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRatios(ratios.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="btn btn-sm self-start"
                  disabled={watched.length < 2 || ratios.length >= 10}
                  onClick={() => setRatios([...ratios, { id: `ratio-${Date.now().toString(36)}`, enabled: true, numeratorKey: "", denominatorKey: "", percent: false, min: null, max: null }])}
                >
                  + Ratio check
                </button>
              </div>
            </section>
          )}

          {!creating && target.versions.length > 0 && (
            <section aria-labelledby="ed-history" data-testid="editor-history">
              <h3 id="ed-history" className="eyebrow mb-2">
                History
              </h3>
              <ul className="space-y-1 text-[12px]">
                {target.versions.map((v, i) => (
                  <li key={v.version} className="flex flex-wrap items-center gap-x-2">
                    <span className="num font-medium">v{v.version}</span>
                    <span className="text-muted">{v.at}</span>
                    <span>{v.byName ?? "?"}</span>
                    <span className="text-muted">
                      {v.action === "revert" ? `reverted to v${v.revertedTo}` : v.action === "create" ? "created" : `changed ${v.changed.join(", ") || "settings"}`}
                    </span>
                    {i > 0 && (
                      <button type="button" className="btn btn-sm btn-ghost ml-auto" disabled={pending} onClick={() => revert(v.version)} aria-label={`Revert to version ${v.version}`}>
                        Revert to this
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          {(problem || state.error) && (
            <p className="min-w-0 flex-1 text-[12px] text-risk" role="status">
              {state.error ?? problem}
            </p>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={!!problem || pending}>
              {creating ? "Create role" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
