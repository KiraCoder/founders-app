import { describe, expect, it } from "vitest";
import { csvSafe, toCsvLine } from "@/lib/csv-safe";

describe("csvSafe (for every future CSV export)", () => {
  it("neutralises cells that a spreadsheet would run as a formula", () => {
    expect(csvSafe("=HYPERLINK(\"http://x\",\"click\")")).toBe(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csvSafe("+996 555")).toBe("'+996 555");
    expect(csvSafe("-2+3")).toBe("'-2+3");
    expect(csvSafe("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvSafe("\t=1")).toBe("'\t=1");
    expect(csvSafe("\r=1")).toBe(`"'\r=1"`);
  });

  it("leaves normal text and numbers alone, quotes separators", () => {
    expect(csvSafe("Асель")).toBe("Асель");
    expect(csvSafe(-1200.5)).toBe("-1200.5");
    expect(csvSafe(32000)).toBe("32000");
    expect(csvSafe(null)).toBe("");
    expect(csvSafe(undefined)).toBe("");
    expect(csvSafe(Number.NaN)).toBe("");
    expect(csvSafe("a,b")).toBe(`"a,b"`);
    expect(csvSafe('say "hi"')).toBe(`"say ""hi"""`);
    expect(csvSafe("line\nbreak")).toBe(`"line\nbreak"`);
    expect(toCsvLine(["Name", "=1+1", 5, null])).toBe("Name,'=1+1,5,");
  });
});
