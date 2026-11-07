/**
 * The people a founder can pick as a task's assignee in the task form: everyone who works
 * for the task's company (active link, not left; founders are picked as users). When editing
 * a task whose assigned person no longer appears in that list (they left or their link
 * ended), that person is kept as an option, so saving another field never silently
 * un-assigns the task.
 */
export interface AssigneeOption {
  id: string;
  name: string;
}

export function assigneePeopleOptions(
  companyPeople: readonly AssigneeOption[],
  current: { kind: "user" | "person"; id: string; name: string } | null | undefined,
  opts: { taskCompanyId: string | null | undefined; companyId: string },
): AssigneeOption[] {
  const list = [...companyPeople];
  if (current?.kind === "person" && opts.companyId && opts.companyId === opts.taskCompanyId && !list.some((p) => p.id === current.id)) {
    list.push({ id: current.id, name: `${current.name} (no longer listed for this company)` });
  }
  return list;
}
