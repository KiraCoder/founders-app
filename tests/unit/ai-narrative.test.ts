import { describe, expect, it } from "vitest";
import type { Finding } from "@/server/ai/finance-rules";
import { assertNoSalaryData, buildNarrativePrompt, generateNarrative, SalaryDataInPromptError } from "@/server/ai/narrative";
import {
  AiProviderError,
  getLlmProvider,
  implementedProviders,
  isAiProviderError,
  NoneProvider,
  providerStatus,
  requireLlmProvider,
  type LlmGenerateInput,
  type LlmProvider,
} from "@/server/ai/provider";

const findings: Finding[] = [
  {
    id: "change:output_pcs:hbk",
    rule: "change",
    severity: "info",
    company: "Alura Style",
    metrics: ["Output per day · ХБК"],
    metricKeys: ["output_pcs"],
    numbers: [{ label: "Output per day · ХБК · October 2026", value: "52 000 pcs" }],
    sentence: "Output per day · ХБК rose 30% vs September (40 000 pcs → 52 000 pcs).",
  },
  {
    id: "ratio:piecework_per_piece:osh-rayon",
    rule: "ratio",
    severity: "risk",
    company: "Alura Style",
    metrics: ["Piecework pay total · Ош Район", "Output per day · Ош Район"],
    metricKeys: ["piecework_total", "output_pcs"],
    numbers: [{ label: "Piecework pay per piece · Ош Район · October 2026", value: "18.75 KGS" }],
    sentence: "Piecework pay per piece · Ош Район rose 50% vs September (12.5 KGS → 18.75 KGS).",
  },
];

const base = { roleName: "Financial Analyst", companyName: "Alura Style", periodLabel: "October 2026" };

describe("provider layer (no provider chosen)", () => {
  it("only 'none' is implemented and it refuses with a typed error, no network", async () => {
    expect(implementedProviders()).toEqual(["none"]);
    const p = getLlmProvider({});
    expect(p).toBeInstanceOf(NoneProvider);
    expect(p.configured).toBe(false);
    const err = await p.generate({ system: "s", messages: [{ role: "user", content: "x" }], maxTokens: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(isAiProviderError(err, "ai_provider_not_configured")).toBe(true);
  });
  it("AI_PROVIDER=none or empty → none; an unknown value falls back to none with a reported problem", () => {
    expect(getLlmProvider({ AI_PROVIDER: "none" }).id).toBe("none");
    expect(providerStatus({ AI_PROVIDER: "" })).toEqual({ requested: "none", id: "none", configured: false, problem: null });
    const s = providerStatus({ AI_PROVIDER: "something-else" });
    expect(s).toMatchObject({ id: "none", configured: false });
    expect(s.problem).toContain("not implemented");
    expect(() => requireLlmProvider({ AI_PROVIDER: "something-else" })).toThrow(AiProviderError);
  });
});

describe("narrative prompt builder", () => {
  it("is deterministic, most severe first, and keeps Russian and English names exactly", () => {
    const a = buildNarrativePrompt({ ...base, findings });
    const b = buildNarrativePrompt({ ...base, findings: [...findings].reverse() });
    expect(a).toEqual(b);
    const user = a.messages[0]!.content;
    expect(user).toContain("Company: Alura Style");
    expect(user).toContain("Month: October 2026");
    expect(user.indexOf("[RISK] Piecework pay per piece · Ош Район")).toBeLessThan(user.indexOf("[INFO] Output per day · ХБК"));
    expect(user).toContain("Ош Район");
    expect(user).toContain("ХБК");
    expect(a.system).toContain("Financial Analyst");
    expect(a.maxTokens).toBe(600);
    expect(buildNarrativePrompt({ ...base, findings: [] }).messages[0]!.content).toContain("(none)");
  });
  it("salary data can't enter a prompt: salary keys, extra fields, salary-named numbers are refused", () => {
    const withSalaryKey = [{ ...findings[0]!, salary: 45000 }] as unknown as Finding[];
    expect(() => buildNarrativePrompt({ ...base, findings: withSalaryKey })).toThrow(SalaryDataInPromptError);
    const extraField = [{ ...findings[0]!, people: ["Асель 45 000"] }] as unknown as Finding[];
    expect(() => buildNarrativePrompt({ ...base, findings: extraField })).toThrow(); // strict schema
    const salaryMetric = [{ ...findings[0]!, metricKeys: ["salary_total"] }];
    expect(() => buildNarrativePrompt({ ...base, findings: salaryMetric })).toThrow(SalaryDataInPromptError);
    const russian = [{ ...findings[0]!, numbers: [{ label: "Оклад · Асель", value: "45 000 KGS" }] }];
    expect(() => buildNarrativePrompt({ ...base, findings: russian })).toThrow(SalaryDataInPromptError);
    expect(() => assertNoSalaryData({ links: [{ personCompanyId: "x" }] })).toThrow(SalaryDataInPromptError);
    expect(() => assertNoSalaryData({ text: "Зарплата за октябрь" })).toThrow(SalaryDataInPromptError);
    // Company totals are not a person's salary.
    expect(() => assertNoSalaryData({ label: "Piecework pay total · ХБК" })).not.toThrow();
  });
});

describe("generateNarrative", () => {
  it("with none: nothing is called, narrative_skipped", async () => {
    const r = await generateNarrative({ ...base, findings }, getLlmProvider({}));
    expect(r).toEqual({ status: "narrative_skipped", text: null, provider: "none" });
  });
  it("a configured provider (test double) gets only the built prompt; its failure never breaks the report", async () => {
    const calls: LlmGenerateInput[] = [];
    const ok: LlmProvider = {
      id: "test-double",
      configured: true,
      async generate(input) {
        calls.push(input);
        return { text: " Output rose. ", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    expect(await generateNarrative({ ...base, findings }, ok)).toEqual({ status: "narrative_done", text: "Output rose.", provider: "test-double" });
    expect(calls[0]).toEqual(buildNarrativePrompt({ ...base, findings }));
    const broken: LlmProvider = { id: "broken", configured: true, generate: async () => Promise.reject(new Error("boom")) };
    expect(await generateNarrative({ ...base, findings }, broken)).toMatchObject({ status: "narrative_failed", error: "boom" });
  });
});
