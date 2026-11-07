/**
 * Safe CSV cells for any export (people, numbers, ...).
 *
 * A spreadsheet treats a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage
 * return as a formula ("CSV injection"): a name like `=HYPERLINK(...)` typed into the app
 * would run when someone opens the export in Excel. `csvSafe` puts a `'` in front of such
 * text (Excel shows it as plain text) and quotes the cell when needed. Numbers stay numbers
 * (a negative number is not text and is not prefixed).
 *
 * Every future CSV export must build its cells with `csvSafe` / `toCsvLine`.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvSafe(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  let s = value;
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[",;\n\r]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** One CSV line (comma-separated) of safe cells, without the line break. */
export function toCsvLine(cells: (string | number | boolean | null | undefined)[]): string {
  return cells.map(csvSafe).join(",");
}
