import type { FilterPerson } from "@/components/ui/FilterBar";
import type { TaskFormOptions } from "@/server/services/options";

/**
 * People for a list's person filter: founders (any company) and staff with the companies they
 * work for, so the FilterBar can limit the list to the chosen company's people.
 */
export function filterPeople(options: Pick<TaskFormOptions, "founders" | "peopleByCompany">): FilterPerson[] {
  const staff = new Map<string, { label: string; companyIds: string[] }>();
  for (const [companyId, list] of Object.entries(options.peopleByCompany)) {
    for (const p of list) {
      const e = staff.get(p.id) ?? { label: p.name, companyIds: [] };
      e.companyIds.push(companyId);
      staff.set(p.id, e);
    }
  }
  return [
    ...options.founders.map((f) => ({ value: `user:${f.id}`, label: `${f.shortName} (founder)`, companyIds: null })),
    ...[...staff.entries()]
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([id, e]) => ({ value: `person:${id}`, label: e.label, companyIds: e.companyIds })),
  ];
}
