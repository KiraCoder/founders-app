import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { ServiceContext } from "@/server/services/context";
import {
  ImportFileError,
  MAX_XLSX_ENTRIES,
  MAX_XLSX_ENTRY_BYTES,
  parseTableFile,
} from "@/server/import/parse-table";
import { createTestDb, type TestDb } from "../helpers/db";

// Both upload wizards (people and numbers) are server actions: point them at the test DB.
const state = vi.hoisted(() => ({ ctx: null as ServiceContext | null }));
vi.mock("@/server/context", () => ({
  getApiContext: async () => state.ctx,
  getPageContext: async () => state.ctx,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { importAction } = await import("@/app/(app)/people/actions");
const { importNumbersAction } = await import("@/app/(app)/companies/actions");

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  state.ctx = t.ctx("nuraaly");
});
afterAll(async () => {
  await t.handle.close();
});

const err = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof ImportFileError ? e.message : `unexpected: ${String(e)}`),
  );

/** A tiny real workbook (as ExcelJS writes it), as a JSZip we can add entries to. */
async function workbookZip(): Promise<JSZip> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("People");
  ws.addRow(["ФИО", "Телефон"]);
  ws.addRow(["Асель", "0555 000 111"]);
  return JSZip.loadAsync(new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer));
}

const deflate = (zip: JSZip) =>
  zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });

/** Generated at test time (never stored): ~30 MB of zeros that compress to a few KB. */
async function bombXlsx(): Promise<Uint8Array> {
  const zip = await workbookZip();
  zip.file("xl/media/bomb.bin", new Uint8Array(30 * 1024 * 1024));
  return deflate(zip);
}

/** Rewrites the declared uncompressed size of entry `name` to `size` (a lying archive). */
function forgeDeclaredSize(bytes: Uint8Array, name: string, size: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  const nameAt = (offset: number, len: number) => new TextDecoder().decode(out.subarray(offset, offset + len));
  let forged = 0;
  for (let i = 0; i + 46 <= out.length; i++) {
    const sig = view.getUint32(i, true);
    // Local file header: size at +22, name length at +26, name at +30.
    if (sig === 0x04034b50 && nameAt(i + 30, view.getUint16(i + 26, true)) === name) {
      view.setUint32(i + 22, size, true);
      forged++;
    }
    // Central directory: size at +24, name length at +28, name at +46.
    if (sig === 0x02014b50 && nameAt(i + 46, view.getUint16(i + 28, true)) === name) {
      view.setUint32(i + 24, size, true);
      forged++;
    }
  }
  expect(forged).toBe(2);
  return out;
}

describe(".xlsx zip-bomb guard (shared by every importer)", () => {
  it("a normal workbook still parses", async () => {
    const zip = await workbookZip();
    const table = await parseTableFile(await deflate(zip), "ok.xlsx");
    expect(table.rows).toEqual([["Асель", "0555 000 111"]]);
    expect(table.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a small file that unpacks to 30 MB, quickly and without unpacking it all", async () => {
    const bytes = await bombXlsx();
    expect(bytes.byteLength).toBeLessThan(200 * 1024);
    const before = process.memoryUsage().rss;
    const started = Date.now();
    expect(await err(parseTableFile(bytes, "bomb.xlsx"))).toMatch(/too much data/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(process.memoryUsage().rss - before).toBeLessThan(300 * 1024 * 1024);
  });

  it("refuses one entry above the per-entry limit even when the total is small", async () => {
    const zip = await workbookZip();
    zip.file("xl/media/big.bin", new Uint8Array(MAX_XLSX_ENTRY_BYTES + 1));
    expect(await err(parseTableFile(await deflate(zip), "big.xlsx"))).toMatch(/too much data/);
  });

  it("stops while unpacking when the declared sizes lie", async () => {
    const zip = await workbookZip();
    zip.file("xl/media/liar.bin", new Uint8Array(12 * 1024 * 1024));
    const forged = forgeDeclaredSize(await deflate(zip), "xl/media/liar.bin", 1000);
    // The archive itself claims the entry is 1000 bytes...
    const declared = (await JSZip.loadAsync(forged)).files["xl/media/liar.bin"] as unknown as { _data: { uncompressedSize: number } };
    expect(declared._data.uncompressedSize).toBe(1000);
    // ...but the running byte cap stops it at the real 10 MB limit.
    expect(await err(parseTableFile(forged, "liar.xlsx"))).toMatch(/too much data/);
  });

  it("refuses an archive with too many entries", async () => {
    const zip = await workbookZip();
    for (let i = 0; i <= MAX_XLSX_ENTRIES; i++) zip.file(`xl/media/p${i}.txt`, "x");
    expect(await err(parseTableFile(await deflate(zip), "many.xlsx"))).toMatch(/too many parts/);
  });

  it("both upload wizards (people and numbers) refuse the bomb with a message", async () => {
    const bytes = await bombXlsx();
    const fd = (extra: Record<string, string>) => {
      const f = new FormData();
      f.set("file", new File([bytes as BlobPart], "bomb.xlsx"));
      for (const [k, v] of Object.entries(extra)) f.set(k, v);
      return f;
    };
    const people = await importAction({ step: "upload" }, fd({ step: "analyze" }));
    expect(people.error).toMatch(/too much data/);
    expect(people.step).toBe("upload");
    const numbers = await importNumbersAction({ step: "upload" }, fd({ step: "preview", companyId: t.companyIds["kiwi-go"]! }));
    expect(numbers.error).toMatch(/too much data/);
    expect(numbers.plan).toBeUndefined();
  });
});

describe("CSV encodings", () => {
  const csv = "ФИО,Телефон\nАсель Ёлкина,0555 000 111\n";
  it("reads UTF-16 LE with BOM (Excel “Unicode text”)", async () => {
    const body = Buffer.from(csv, "utf16le");
    const bytes = new Uint8Array([0xff, 0xfe, ...body]);
    const table = await parseTableFile(bytes, "u16le.csv");
    expect(table.headers).toEqual(["ФИО", "Телефон"]);
    expect(table.rows).toEqual([["Асель Ёлкина", "0555 000 111"]]);
  });

  it("reads UTF-16 BE with BOM", async () => {
    const le = Buffer.from(csv, "utf16le");
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1]!;
      be[i + 1] = le[i]!;
    }
    const table = await parseTableFile(new Uint8Array([0xfe, 0xff, ...be]), "u16be.csv");
    expect(table.headers).toEqual(["ФИО", "Телефон"]);
    expect(table.rows[0]![0]).toBe("Асель Ёлкина");
  });

  it("the file hash changes with one byte", async () => {
    const a = await parseTableFile(new TextEncoder().encode("Name\nA\n"), "a.csv");
    const b = await parseTableFile(new TextEncoder().encode("Name\nB\n"), "b.csv");
    expect(a.sha256).not.toBe(b.sha256);
  });
});
