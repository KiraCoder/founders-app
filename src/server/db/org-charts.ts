/**
 * Writes an org chart from a template (C3b). No "server-only": shared by the org service
 * ("Apply Vysotsky template") and the seed (Kiwi Go), which also runs from CLI scripts.
 */
import { divisionDisplayRank, type TemplateDivision } from "@/lib/org";
import { ServiceError } from "@/server/services/errors";
import type { Db } from "./connect";
import { orgChangeLog, orgCharts, orgDepartments, orgDivisions, orgFunctions } from "./schema";

export interface ChartScope {
  companyId: string;
  companyUnitId: string | null;
}

/**
 * Writes a chart from a template (divisions → departments → functions) in the given
 * transaction. Refuses when the company (unit) already has a chart. Used by "Apply Vysotsky
 * template" and by the seed (Kiwi Go).
 */
export async function createChartFromTemplate(
  db: Db,
  input: ChartScope & { templateKey: string; divisions: TemplateDivision[]; actorUserId: string | null; action: "apply_template" | "seed"; summary: string; now: Date },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [chart] = await tx
      .insert(orgCharts)
      .values({ companyId: input.companyId, companyUnitId: input.companyUnitId, templateKey: input.templateKey, createdBy: input.actorUserId, createdAt: input.now, updatedAt: input.now })
      .onConflictDoNothing()
      .returning({ id: orgCharts.id });
    if (!chart) throw new ServiceError("conflict", "This company already has an org chart");
    const ordered = [...input.divisions].sort((a, b) => divisionDisplayRank(a.number) - divisionDisplayRank(b.number));
    for (const [di, d] of ordered.entries()) {
      const [div] = await tx
        .insert(orgDivisions)
        .values({
          chartId: chart.id,
          companyId: input.companyId,
          number: d.number,
          name: d.name,
          nameIsDefault: d.nameIsDefault ?? false,
          headTitle: d.headTitle ?? "",
          reportsTo: d.reportsTo ?? "",
          ckp: d.ckp ?? "",
          sort: di,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ id: orgDivisions.id });
      for (const [i, dep] of d.departments.entries()) {
        const [row] = await tx
          .insert(orgDepartments)
          .values({
            chartId: chart.id,
            companyId: input.companyId,
            divisionId: div!.id,
            number: dep.number,
            name: dep.name,
            nameIsDefault: dep.nameIsDefault ?? false,
            ckp: dep.ckp ?? "",
            statistic: dep.statistic ?? "",
            sort: i,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning({ id: orgDepartments.id });
        if (dep.functions?.length) {
          await tx.insert(orgFunctions).values(
            dep.functions.map((text, fi) => ({ chartId: chart.id, companyId: input.companyId, departmentId: row!.id, text, sort: fi, createdAt: input.now, updatedAt: input.now })),
          );
        }
      }
    }
    await tx.insert(orgChangeLog).values({
      chartId: chart.id,
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      entity: "chart",
      entityId: chart.id,
      action: input.action,
      before: null,
      after: { templateKey: input.templateKey },
      summary: input.summary,
      createdAt: input.now,
    });
    return chart.id;
  });
}

