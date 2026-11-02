/**
 * Server-side parsing of an uploaded spreadsheet (.xlsx via exceljs, .csv via papaparse)
 * into a header row and string cells. Nothing is written to disk: the bytes are parsed
 * in memory and dropped when the request ends.
 *
 * No "server-only" so tests can import it directly; it has no secrets or DB access.
 */
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import Papa from "papaparse";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_COLUMNS = 50;

/**
 * Limits for the inside of an .xlsx (a zip archive). A 2 MB zip can unpack to gigabytes
 * (a "zip bomb"), so the archive is checked BEFORE the spreadsheet parser sees it:
 * at most this many entries, no entry larger than this once unpacked, and not more than
 * this in total. Declared sizes can lie, so every entry is also unpacked as a stream and
 * stopped as soon as the real byte count passes the limit.
 */
export const MAX_XLSX_ENTRIES = 100;
export const MAX_XLSX_ENTRY_BYTES = 10 * 1024 * 1024;
export const MAX_XLSX_TOTAL_BYTES = 25 * 1024 * 1024;

export interface ParsedTable {
  headers: string[];
  /** Data rows (after the header row), cells as trimmed strings. */
  rows: string[][];
  /** Spreadsheet row number (1-based) of each data row, for error messages. */
  rowNumbers: number[];
  /**
   * sha256 (hex) of the uploaded bytes. The preview returns it and the confirm step must
   * send the same value, so the rows applied are the rows that were previewed.
   */
  sha256: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("");
    if ("text" in value && typeof value.text === "string") return value.text; // hyperlink
    if ("result" in value) return cellToString((value.result ?? "") as ExcelJS.CellValue); // formula
    if ("error" in value) return "";
  }
  return String(value);
}

export function decodeText(bytes: Uint8Array): string {
  // "Unicode text" from Excel is UTF-16 with a byte order mark (FF FE or FE FF).
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    // Excel on Russian Windows saves CSV as Windows-1251.
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

const tooLarge = () =>
  new ImportFileError("This .xlsx file unpacks to too much data (more than 25 MB). Save only the sheet you need and retry.");

/**
 * Zip-bomb guard for .xlsx: checks entry count and declared sizes, then unpacks every
 * entry as a stream with a running byte cap (declared sizes can be forged). Nothing
 * unpacked is kept; the spreadsheet parser runs only after this passes.
 */
export async function assertSafeXlsx(bytes: Uint8Array): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ImportFileError("This .xlsx file could not be read. Save it again from Excel and retry.");
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_XLSX_ENTRIES) throw new ImportFileError("This .xlsx file has too many parts. Save it again from Excel and retry.");
  let declared = 0;
  for (const e of entries) {
    const size = (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (size > MAX_XLSX_ENTRY_BYTES) throw tooLarge();
    declared += size;
    if (declared > MAX_XLSX_TOTAL_BYTES) throw tooLarge();
  }
  let total = 0;
  for (const e of entries) {
    if (e.dir) continue;
    await new Promise<void>((resolve, reject) => {
      let entryBytes = 0;
      let stopped = false;
      const stream = (e as unknown as { internalStream(t: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array> }).internalStream(
        "uint8array",
      );
      stream
        .on("data", (chunk: Uint8Array) => {
          if (stopped) return;
          entryBytes += chunk.byteLength;
          total += chunk.byteLength;
          if (entryBytes > MAX_XLSX_ENTRY_BYTES || total > MAX_XLSX_TOTAL_BYTES) {
            stopped = true;
            stream.pause();
            reject(tooLarge());
          }
        })
        .on("error", () => {
          if (stopped) return;
          stopped = true;
          reject(new ImportFileError("This .xlsx file could not be read. Save it again from Excel and retry."));
        })
        .on("end", () => {
          if (!stopped) resolve();
        })
        .resume();
    });
  }
}

function finish(raw: string[][], sha256: string): ParsedTable {
  const cleaned = raw.map((r) => r.slice(0, MAX_IMPORT_COLUMNS).map((c) => (c ?? "").toString().trim()));
  const headerIdx = cleaned.findIndex((r) => r.some((c) => c !== ""));
  if (headerIdx < 0) throw new ImportFileError("The file is empty.");
  const headers = cleaned[headerIdx]!;
  const width = headers.length;
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let i = headerIdx + 1; i < cleaned.length; i++) {
    const r = cleaned[i]!;
    if (!r.some((c) => c !== "")) continue;
    rows.push(Array.from({ length: width }, (_, j) => r[j] ?? ""));
    rowNumbers.push(i + 1);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ImportFileError(`Too many rows (more than ${MAX_IMPORT_ROWS}). Split the file.`);
    }
  }
  return { headers, rows, rowNumbers, sha256 };
}

/** Parses .xlsx or .csv bytes. Throws ImportFileError with a user-facing message. */
export async function parseTableFile(bytes: Uint8Array, filename: string): Promise<ParsedTable> {
  if (bytes.byteLength === 0) throw new ImportFileError("The file is empty.");
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new ImportFileError("The file is larger than 2 MB.");
  const name = filename.toLowerCase();
  const sha256 = sha256Hex(bytes);

  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const text = decodeText(bytes);
    const res = Papa.parse<string[]>(text, { skipEmptyLines: false, delimiter: "" });
    if (res.errors.some((e) => e.type === "Quotes")) {
      throw new ImportFileError(`The CSV could not be read (row ${(res.errors[0]?.row ?? 0) + 1}: ${res.errors[0]?.message}).`);
    }
    return finish(res.data, sha256);
  }

  if (name.endsWith(".xlsx")) {
    // xlsx files are zip archives: check the signature before handing them to the parser.
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new ImportFileError("This is not a valid .xlsx file.");
    await assertSafeXlsx(bytes);
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    } catch {
      throw new ImportFileError("This .xlsx file could not be read. Save it again from Excel and retry.");
    }
    const ws = wb.worksheets.find((w) => w.state === "visible" && w.actualRowCount > 0) ?? wb.worksheets[0];
    if (!ws) throw new ImportFileError("The workbook has no sheets.");
    if (ws.rowCount > MAX_IMPORT_ROWS + 50) {
      throw new ImportFileError(`Too many rows (more than ${MAX_IMPORT_ROWS}). Split the file.`);
    }
    const raw: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: string[] = [];
      const count = Math.min(row.cellCount, MAX_IMPORT_COLUMNS);
      for (let c = 1; c <= count; c++) cells.push(cellToString(row.getCell(c).value));
      raw[rowNumber - 1] = cells;
    });
    for (let i = 0; i < raw.length; i++) raw[i] ??= [];
    return finish(raw, sha256);
  }

  if (name.endsWith(".xls")) {
    throw new ImportFileError("Old .xls files are not supported. In Excel use File → Save As → .xlsx (or .csv).");
  }
  throw new ImportFileError("Upload a .xlsx or .csv file.");
}
