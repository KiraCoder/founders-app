"use server";

import { CACHE_TAGS, refreshAfterWrite } from "@/server/cache";
import { getPageContext } from "@/server/context";
import { ImportFileError, MAX_IMPORT_BYTES, parseTableFile, type ParsedTable } from "@/server/import/parse-table";
import { checkConnector } from "@/server/services/connectors";
import { toServiceError } from "@/server/services/errors";
import { recordMetricValue, saveMetricGrid, type GridResult } from "@/server/services/metrics";
import { applyMetricsImport, planMetricsImport, type MetricImportPlan } from "@/server/services/metrics-import";

const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : undefined;
};

export interface MetricActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  message?: string;
  nonce?: number;
}

/** "Enter value" on a KPI card. */
export async function enterMetricValueAction(_prev: MetricActionState, fd: FormData): Promise<MetricActionState> {
  const ctx = await getPageContext();
  try {
    const res = await recordMetricValue(ctx, str(fd, "metricId") ?? "", {
      period: str(fd, "period") ?? "",
      value: str(fd, "value") ?? "",
      // Empty = keep the existing note (the REST API clears one with `note: null`).
      note: str(fd, "note")?.trim() || undefined,
    });
    refreshAfterWrite(CACHE_TAGS.metricValues);
    return {
      ok: true,
      message: res.action === "unchanged" ? "Same value as before — nothing changed." : res.action === "updated" ? "Corrected (the old value is kept in history)." : "Saved.",
      nonce: Date.now(),
    };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
}

export interface GridState {
  ok?: boolean;
  error?: string;
  result?: GridResult;
  nonce?: number;
}

/** Numbers tab: the browser sends only the changed cells as JSON. */
export async function saveMetricGridAction(_prev: GridState, fd: FormData): Promise<GridState> {
  const ctx = await getPageContext();
  try {
    let cells: unknown = [];
    try {
      cells = JSON.parse(str(fd, "cells") ?? "[]");
    } catch {
      return { ok: false, error: "Could not read the grid. Reload the page." };
    }
    const result = await saveMetricGrid(ctx, str(fd, "companyId") ?? "", cells);
    refreshAfterWrite(CACHE_TAGS.metricValues);
    return { ok: result.errors.length === 0, result, nonce: Date.now() };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message };
  }
}

export interface NumbersImportState {
  step: "upload" | "preview" | "done";
  error?: string;
  fileName?: string;
  plan?: MetricImportPlan;
  applied?: number;
}

async function readUpload(fd: FormData): Promise<{ table: ParsedTable; name: string } | { error: string }> {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a .xlsx or .csv file." };
  if (file.size > MAX_IMPORT_BYTES) return { error: "The file is larger than 2 MB." };
  try {
    return { table: await parseTableFile(new Uint8Array(await file.arrayBuffer()), file.name), name: file.name };
  } catch (err) {
    if (err instanceof ImportFileError) return { error: err.message };
    throw err;
  }
}

/** Upload wizard: "preview" and "confirm" steps (the browser sends the file each time; nothing is stored). */
export async function importNumbersAction(prev: NumbersImportState, fd: FormData): Promise<NumbersImportState> {
  const ctx = await getPageContext();
  const upload = await readUpload(fd);
  if ("error" in upload) return { ...prev, error: upload.error };
  const companyId = str(fd, "companyId") ?? "";
  try {
    if (str(fd, "step") === "confirm") {
      const { applied, ...plan } = await applyMetricsImport(ctx, companyId, upload.table, {
        expectedSha256: str(fd, "fileSha256") ?? "",
      });
      refreshAfterWrite(CACHE_TAGS.metricValues);
      return { step: "done", fileName: upload.name, plan, applied };
    }
    return { step: "preview", fileName: upload.name, plan: await planMetricsImport(ctx, companyId, upload.table) };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { step: "upload", fileName: upload.name, error: se.message };
  }
}

/** "Check now" on a data source: runs the connector for the last 7 days (stubs only log "not configured"). */
export async function checkConnectorAction(connectorId: string): Promise<MetricActionState> {
  const ctx = await getPageContext();
  try {
    const res = await checkConnector(ctx, connectorId);
    refreshAfterWrite(CACHE_TAGS.metricValues);
    return { ok: res.status === "ok", message: res.message, nonce: Date.now() };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message };
  }
}
