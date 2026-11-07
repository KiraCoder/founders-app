import "server-only";
import type { ParsedTable } from "@/server/import/parse-table";
import { ServiceError } from "./errors";

/**
 * Shared rules for every spreadsheet import (people, numbers).
 *
 * Preview and confirm are two requests and the browser sends the file again for the
 * confirm step. The preview returns the file's sha256; confirm must send it back, so what
 * is written is exactly the file that was previewed.
 */

/** Throws `conflict` when the confirmed file is not the previewed one (used by every importer). */
export function assertSameFile(table: ParsedTable, expectedSha256: string | null | undefined): void {
  if (!expectedSha256 || expectedSha256.toLowerCase() !== table.sha256) {
    throw new ServiceError(
      "conflict",
      "This is not the file you previewed (it changed or another file was chosen). Preview it again before importing.",
    );
  }
}
