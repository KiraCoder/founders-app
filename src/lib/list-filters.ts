import { isIsoDate } from "./dates";

/**
 * The URL params of a list's FilterBar (src/components/ui/FilterBar.tsx), read on the server.
 * Bad values are dropped (a hand-edited URL never errors).
 */
export interface ListFilters {
  status: string;
  quick: string[];
  search: string;
  company: string | null;
  /** "person:<id>" / "user:<id>". */
  who: string | null;
  personId: string | null;
  userId: string | null;
  from: string | null;
  to: string | null;
  sort: string;
  /** The params as they are (for the FilterBar and its links). */
  query: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readListFilters(
  sp: Record<string, string | string[] | undefined>,
  allowed: { statuses: readonly string[]; quick: readonly string[]; sorts: readonly string[] },
): ListFilters {
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");
  const status = allowed.statuses.includes(str("status")) ? str("status") : "";
  const quick = [...new Set(str("quick").split(",").filter((q) => allowed.quick.includes(q)))];
  const search = str("search").slice(0, 200);
  const company = UUID.test(str("company")) ? str("company") : null;
  const whoRaw = str("who");
  const m = /^(person|user):([0-9a-f-]{36})$/i.exec(whoRaw);
  const who = m && UUID.test(m[2]!) ? whoRaw : null;
  const from = isIsoDate(str("from")) ? str("from") : null;
  const to = isIsoDate(str("to")) ? str("to") : null;
  const sort = allowed.sorts.includes(str("sort")) ? str("sort") : "";
  const query: Record<string, string> = {};
  const put = (k: string, v: string | null) => {
    if (v) query[k] = v;
  };
  put("status", status);
  put("quick", quick.join(","));
  put("search", search);
  put("company", company);
  put("who", who);
  put("from", from);
  put("to", to);
  put("sort", sort);
  return {
    status,
    quick,
    search,
    company,
    who,
    personId: who?.startsWith("person:") ? who.slice(7) : null,
    userId: who?.startsWith("user:") ? who.slice(5) : null,
    from,
    to,
    sort,
    query,
  };
}
