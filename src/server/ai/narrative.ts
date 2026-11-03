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
 * fields (salary, amount by person, pay type, person links) or salary-named metrics
 * (salary / оклад / зарплата / ФОТ by person). Company totals such as "Piecework pay total"
 * are group numbers, not a person's salary, and are allowed.
 *
 * Pure except `generateNarrative`, which calls the provider it is given.
 */
import { z } from "zod";
import type { Finding } from "./finance-rules";
import { isAiProviderError, type LlmGenerateInput, type LlmProvider } from "./provider";

export type NarrativeStatus = "narrative_skipped" | "narrative_done" | "narrative_failed";

export class SalaryDataInPromptError extends Error {
  constructor(where: string) {
    super(`Salary data may never be sent to an AI provider (found at ${where})`);
    this.name = "SalaryDataInPromptError";
  }
}

/** Keys that only salary / per-person pay data has. */
const SALARY_KEY = /^(salary|salaries|salaryHistory|payType|pay_type|personCompanyId|person_company_id|effectiveFrom|effective_from|personId|person_id)$/i;
/** Words that mark a salary in a label or a metric key (English and Russian). */
const SALARY_WORD = /(salar|оклад|зарплат|заработн|(^|[^а-яё])зп([^а-яё]|$))/i;

/**
 * Throws SalaryDataInPromptError when `value` (deeply) has a salary-only key, or a string
 * that names a salary. Called on every prompt input and again on the finished prompt.
 */
export function assertNoSalaryData(value: unknown, where = "input"): void {
  if (typeof value === "string") {
    if (SALARY_WORD.test(value)) throw new SalaryDataInPromptError(where);
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
  assertNoSalaryData(raw);
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
  assertNoSalaryData(prompt, "prompt");
  return prompt;
}

export interface NarrativeResult {
  status: NarrativeStatus;
  text: string | null;
  provider: string;
  error?: string;
}

/**
 * Calls the provider only when one is configured. With "none" nothing is called and the
 * result is `narrative_skipped`. A provider failure never fails the report.
 */
export async function generateNarrative(
  input: { roleName: string; companyName: string; periodLabel: string; findings: readonly Finding[] },
  provider: LlmProvider,
): Promise<NarrativeResult> {
  const prompt = buildNarrativePrompt({ ...input, findings: [...input.findings] });
  if (!provider.configured) return { status: "narrative_skipped", text: null, provider: provider.id };
  try {
    const res = await provider.generate(prompt);
    const text = res.text.trim();
    return text ? { status: "narrative_done", text: text.slice(0, 4000), provider: provider.id } : { status: "narrative_failed", text: null, provider: provider.id, error: "empty" };
  } catch (err) {
    if (isAiProviderError(err, "ai_provider_not_configured")) return { status: "narrative_skipped", text: null, provider: provider.id };
    return { status: "narrative_failed", text: null, provider: provider.id, error: err instanceof Error ? err.message.slice(0, 300) : "error" };
  }
}
