import { z } from "zod";

/** One value typed by a founder (form, REST). The period is any day inside it ("2026-10", "2026-10-31"). */
export const metricValueInputSchema = z
  .object({
    period: z.string().trim().min(1, "Choose the period").max(20),
    value: z.union([z.number(), z.string().trim().min(1, "Enter a number").max(40)]),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();
export type MetricValueInput = z.input<typeof metricValueInputSchema>;

/** The Numbers grid: only the cells that were changed. Empty value = leave as is. */
export const metricGridInputSchema = z
  .array(
    z
      .object({
        metricId: z.uuid(),
        period: z.string().trim().min(1).max(20),
        value: z.string().trim().max(40),
      })
      .strict(),
  )
  .max(1000);
