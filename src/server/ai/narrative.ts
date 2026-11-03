/**
 * The optional AI narrative on top of a report. The analysis itself is deterministic
 * (finance-rules.ts); this layer only asks a provider to write a short summary of the
 * findings. While no provider is chosen (AI_PROVIDER=none) it is skipped and the run records
 * `narrative_skipped`; the report page says "AI summary appears after the AI provider is
 * chosen".
 *
 * **No raw salaries ever enter a prompt.** The prompt is built ONLY from findings (metric
 * labels, company name, month, numbers already shown in the report), validated by a strict
 * schema, and `assertNoSalaryData` refuses anything that looks like salary data — salary
 * fields (salary, amount by person, pay type, person links) or pay-named metrics in a label,
 * sentence or metric key (salary, payroll, wage(s), зарплата, заработная плата, ЗП, ФОТ,
 * оплата труда, оклад; keys like `payroll_fund`, `fot`, `zp_total`). Findings about such a
 * metric are left out of the prompt (`salaryLikeFinding`); if the prompt is still refused the
 * run records `narrative_skipped:salary` — the report itself never fails because of it.
 * The only pay number allowed is the factory's piecework pay TOTAL, by explicit key
 * (`ALLOWED_PAY_KEYS`): a group number, not a person's salary.
 *
 * Pure except `generateNarrative`, which calls the provider it is given.
 */
import { z } from "zod";
import type { Finding } from "./finance-rules";
import { isAiProviderError, type LlmGenerateInput, type LlmProvider } from "./provider";

/**
 * narrative_skipped        — no provider chosen (nothing built, nothing sent)
 * narrative_skipped:salary — the safety check refused the prompt (nothing sent; the report is fine)
 */
export type NarrativeStatus = "narrative_skipped" | "narrative_skipped:salary" | "narrative_done" | "narrative_failed";

export class SalaryDataInPromptError extends Error {
  constructor(where: string) {
    super(`Salary data may never be sent to an AI provider (found at ${where})`);
    this.name = "SalaryDataInPromptError";
  }
}

/** Keys that only salary / per-person pay data has. */
const SALARY_KEY = /^(salary|salaries|salaryHistory|payType|pay_type|personCompanyId|person_company_id|effectiveFrom|effective_from|personId|person_id)$/i;
/** Words that mark pay data in a label, sentence or metric key (English and Russian). */
const SALARY_WORD = /(salar|payroll|wage|оклад|зарплат|заработн|оплат[аыуе]?\s+труда|(^|[^а-яё])(зп|фот)([^а-яё]|$))/i;
/** Metric keys (snake_case, Latin) that name pay data. */
const SALARY_METRIC_KEY = /(^|_)(salary|salaries|payroll|wages?|fot|zp|oklad|zarplat[a-z]*|zarabotn[a-z]*)(_|$)/i;
/** Pay numbers that may be sent: company / factory totals, never a person's pay. */
export const ALLOWED_PAY_KEYS: ReadonlySet<string> = new Set(["piecework_total"]);

function isSalaryText(v: string): boolean {
  return SALARY_WORD.test(v) || SALARY_METRIC_KEY.test(v);
}

/**
 * A finding about pay data (by metric key, metric label, number label or sentence). Findings
 * whose metric keys are all on the allow-list (piecework pay total) are not.
 */
export function salaryLikeFinding(f: Pick<Finding, "metricKeys" | "metrics" | "numbers" | "sentence">): boolean {
  if (f.metricKeys.length && f.metricKeys.every((k) => ALLOWED_PAY_KEYS.has(k))) return false;
  if (f.metricKeys.some((k) => !ALLOWED_PAY_KEYS.has(k) && isSalaryText(k))) return true;
  return [...f.metrics, ...f.numbers.map((n) => n.label), f.sentence].some((t) => SALARY_WORD.test(t));
}

/**
 * Throws SalaryDataInPromptError when `value` (deeply) has a salary-only key, or a string
 * that names a salary. Called on every prompt input and again on the finished prompt.
 */
export function assertNoSalaryData(value: unknown, where = "input"): void {
  if (typeof value === "string") {
    if (isSalaryText(value)) throw new SalaryDataInPromptError(where);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSalaryData(v, `${where}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SALARY_KEY.test(k)) throw new SalaryDataInPromptError(`${where}.${k}`);
      assertNoSalaryData(v, `${where}.${k}`);
    }
  }
}

const promptFindingSchema = z
  .object({
    id: z.string(),
    rule: z.string(),
    severity: z.enum(["risk", "warn", "info"]),
    company: z.string(),
    metrics: z.array(z.string()),
    metricKeys: z.array(z.string()),
    numbers: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
    sentence: z.string(),
    taskId: z.string().nullable().optional(),
  })
  .strict();

export const narrativeInputSchema = z
  .object({
    roleName: z.string().min(1),
    companyName: z.string().min(1),
    periodLabel: z.string().min(1),
    findings: z.array(promptFindingSchema),
  })
  .strict();
export type NarrativeInput = z.input<typeof narrativeInputSchema>;

const SEVERITY_WORD = { risk: "RISK", warn: "WARNING", info: "INFO" } as const;
const SEVERITY_RANK = { risk: 0, warn: 1, info: 2 } as const;

/**
 * The prompt for the narrative. Deterministic (same findings → same text: findings sorted
 * by severity then id), names kept exactly as written (Russian and English; NFC only).
 * Refuses salary data (see the header).
 */
export function buildNarrativePrompt(raw: NarrativeInput): LlmGenerateInput {
  const { findings: rawFindings, ...head } = raw;
  assertNoSalaryData(head);
  // Every finding is checked; an allow-listed pay total (piecework) is exempt from the word
  // check only — salary-only fields are refused everywhere.
  (rawFindings ?? []).forEach((f, i) => assertNoSalaryData(allowListed(f) ? stripText(f) : f, `input.findings[${i}]`));
  const input = narrativeInputSchema.parse(raw);
  const nfc = (s: string) => s.normalize("NFC");
  const findings = [...input.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id));
  const lines = findings.map((f, i) => {
    const nums = f.numbers.map((n) => `${nfc(n.label)} = ${nfc(n.value)}`).join("; ");
    return `${i + 1}. [${SEVERITY_WORD[f.severity]}] ${nfc(f.sentence)}${nums ? ` Numbers: ${nums}.` : ""}`;
  });
  const system = [
    `You are the ${nfc(input.roleName)} for a group of companies run by two founders.`,
    "Write a short summary (at most 5 sentences, plain English) of the findings you are given.",
    "Use only the facts and numbers in the findings. Do not invent numbers. Keep company, factory and metric names exactly as written (some are in Russian).",
    "Start with the most serious finding. If there are no findings, say the month looks normal.",
  ].join("\n");
  const user = [
    `Company: ${nfc(input.companyName)}`,
    `Month: ${nfc(input.periodLabel)}`,
    `Findings (${findings.length}):`,
    ...(lines.length ? lines : ["(none)"]),
  ].join("\n");
  const prompt: LlmGenerateInput = { system, messages: [{ role: "user", content: user }], maxTokens: 600 };
  // The finished prompt again, minus the lines of allow-listed findings (checked above).
  const allowedLines = new Set(findings.flatMap((f, i) => (allowListed(f) ? [lines[i]!] : [])));
  assertNoSalaryData({ system, user: user.split("\n").filter((l) => !allowedLines.has(l)) }, "prompt");
  return prompt;
}

function allowListed(f: { metricKeys?: unknown }): boolean {
  return Array.isArray(f.metricKeys) && f.metricKeys.length > 0 && f.metricKeys.every((k) => typeof k === "string" && ALLOWED_PAY_KEYS.has(k));
}

/** The finding without its free text (for the key check of an allow-listed finding). */
function stripText(f: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) out[k] = typeof v === "string" || Array.isArray(v) ? null : v;
  return out;
}

export interface NarrativeResult {
  status: NarrativeStatus;
  text: string | null;
  provider: string;
  /** Findings about pay data left out of the prompt. */
  omitted?: number;
  error?: string;
}

/**
 * Calls the provider only when one is configured. With "none" no prompt is even built and the
 * result is `narrative_skipped`. Findings about pay data are left out of the prompt; if the
 * safety check still refuses it, nothing is sent (`narrative_skipped:salary`). Neither that nor
 * a provider failure ever fails the report.
 */
export async function generateNarrative(
  input: { roleName: string; companyName: string; periodLabel: string; findings: readonly Finding[] },
  provider: LlmProvider,
): Promise<NarrativeResult> {
  if (!provider.configured) return { status: "narrative_skipped", text: null, provider: provider.id };
  const safe = input.findings.filter((f) => !salaryLikeFinding(f));
  const omitted = input.findings.length - safe.length;
  let prompt: LlmGenerateInput;
  try {
    prompt = buildNarrativePrompt({ ...input, findings: safe.map(promptFinding) });
  } catch (err) {
    if (err instanceof SalaryDataInPromptError) return { status: "narrative_skipped:salary", text: null, provider: provider.id, omitted };
    return { status: "narrative_failed", text: null, provider: provider.id, error: err instanceof Error ? err.message.slice(0, 300) : "prompt" };
  }
  try {
    const res = await provider.generate(prompt);
    const text = res.text.trim();
    if (!text) return { status: "narrative_failed", text: null, provider: provider.id, error: "empty" };
    return { status: "narrative_done", text: text.slice(0, 4000), provider: provider.id, ...(omitted ? { omitted } : {}) };
  } catch (err) {
    if (isAiProviderError(err, "ai_provider_not_configured")) return { status: "narrative_skipped", text: null, provider: provider.id };
    return { status: "narrative_failed", text: null, provider: provider.id, error: err instanceof Error ? err.message.slice(0, 300) : "error" };
  }
}

/** Only the schema's fields (a stored finding may carry more later). */
function promptFinding(f: Finding): Finding {
  const { id, rule, severity, company, metrics, metricKeys, numbers, sentence, taskId } = f;
  return { id, rule, severity, company, metrics, metricKeys, numbers: numbers.map(({ label, value }) => ({ label, value })), sentence, ...(taskId !== undefined ? { taskId } : {}) };
}
