/**
 * "Who to ask" for intercompany акты (Holding). Each flow can name a person who works for
 * one of its two companies; a founder can override it for one ask round (a month). The app
 * never messages that person: it only uses the name in the founders' own messages.
 *
 * No "server-only": the seed uses `defaultAskPersonId` too.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./connect";
import { holdingAskOverrides, people, personCompanies } from "./schema";

/** The person as the founders' messages name them. */
export interface AskPerson {
  id: string;
  /** For English lines: "Ask Elmurat for…". */
  name: string;
  /** For the Russian message: "Элмурат, пришлите, пожалуйста, …" (the short name when set). */
  nameRu: string;
}

const ACCOUNTANT = /(accountant|бухгалтер)/i;
const CYRILLIC = /[Ѐ-ӿ]/;

export function askPersonNames(p: { id: string; fullName: string; shortName: string | null }): AskPerson {
  const first = p.fullName.trim().split(/\s+/)[0] || p.fullName.trim();
  const short = p.shortName?.trim() || null;
  const latinShort = short && !CYRILLIC.test(short) ? short : null;
  return {
    id: p.id,
    // English lines use a Latin name: the short name when it is Latin, else the first name.
    name: latinShort ?? first,
    // The Russian message: a Cyrillic short name as written ("Айгуль"), else the name spelled
    // in Cyrillic ("Elmurat" → "Элмурат"). A founder who wants another spelling sets the
    // person's short name in People.
    nameRu: short && CYRILLIC.test(short) ? short : toCyrillic(latinShort ?? first),
  };
}

const VOWELS = "aeiouy";
const MULTI: [string, string][] = [
  ["shch", "щ"], ["zh", "ж"], ["kh", "х"], ["ch", "ч"], ["sh", "ш"], ["ts", "ц"],
  ["yu", "ю"], ["ya", "я"], ["yo", "ё"], ["ye", "е"],
];
const SINGLE: Record<string, string> = {
  a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "дж", k: "к", l: "л", m: "м",
  n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "кс", y: "ы", z: "з",
};

/**
 * Simple Latin → Cyrillic spelling for Kyrgyz / Russian first names written in Latin
 * ("Elmurat" → "Элмурат", "Aibek" → "Айбек", "Nuraaly" → "Нураалы", "Zhyldyz" → "Жылдыз").
 * Anything that is not plain Latin letters is returned unchanged.
 */
export function toCyrillic(name: string): string {
  if (!/^[A-Za-z'-]+$/.test(name)) return name;
  const src = name.toLowerCase();
  let out = "";
  for (let i = 0; i < src.length; ) {
    const multi = MULTI.find(([lat]) => src.startsWith(lat, i));
    if (multi) {
      out += multi[1];
      i += multi[0].length;
      continue;
    }
    const ch = src[i]!;
    const prev = src[i - 1];
    const next = src[i + 1];
    const wordStart = i === 0 || prev === "-" || prev === "'";
    if (ch === "e" && wordStart) out += "э";
    else if (ch === "i" && prev && VOWELS.includes(prev) && (!next || !VOWELS.includes(next))) out += "й";
    else out += SINGLE[ch] ?? ch;
    i++;
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

interface Link {
  personId: string;
  companyId: string;
  accountant: boolean;
}

type FlowLike = { id: string; fromCompanyId: string; toCompanyId: string; askPersonId: string | null };

export interface AskPeopleIndex {
  /** Any person (also one no longer eligible) by id. */
  person(id: string | null | undefined): AskPerson | null;
  /** True when the person works (active link, not left, not an app user) for one of the flow's companies. */
  eligible(flow: Pick<FlowLike, "fromCompanyId" | "toCompanyId">, personId: string | null | undefined): boolean;
  /** People a founder can pick for this flow, by name. */
  options(flow: Pick<FlowLike, "fromCompanyId" | "toCompanyId">): AskPerson[];
  /** The default for a new flow: the accountant (providing company's first), else null. */
  defaultFor(flow: Pick<FlowLike, "fromCompanyId" | "toCompanyId">): string | null;
  /** This round's override for a flow (only when still eligible). */
  override(flow: FlowLike): AskPerson | null;
  /** Who to ask for a missing акт: the round's override, else the flow's person (if still eligible), else nobody. */
  forMissing(flow: FlowLike): AskPerson | null;
  /** Who an акт already asked for is waiting on: the person asked (if still eligible), else as for a missing one. */
  forRequested(flow: FlowLike, requestedPersonId: string | null): AskPerson | null;
}

/**
 * Loads people, their active company links and (with `roundKey` = "YYYY-MM") that round's
 * overrides. People who left, inactive links and app users (the founders) are not eligible.
 */
export async function loadAskPeople(db: Db, roundKey: string | null): Promise<AskPeopleIndex> {
  const [rows, links, overrides] = await Promise.all([
    db.select({ id: people.id, fullName: people.fullName, shortName: people.shortName, leftAt: people.leftAt, userId: people.userId }).from(people),
    db
      .select({ personId: personCompanies.personId, companyId: personCompanies.companyId, role: personCompanies.role, title: personCompanies.title })
      .from(personCompanies)
      .innerJoin(people, eq(people.id, personCompanies.personId))
      .where(and(eq(personCompanies.isActive, true), isNull(people.leftAt), isNull(people.userId))),
    roundKey
      ? db.select({ flowId: holdingAskOverrides.flowId, personId: holdingAskOverrides.personId }).from(holdingAskOverrides).where(eq(holdingAskOverrides.roundKey, roundKey))
      : Promise.resolve([] as { flowId: string; personId: string }[]),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const names = new Map(rows.map((r) => [r.id, askPersonNames(r)]));
  const byCompany = new Map<string, Link[]>();
  for (const l of links) {
    const list = byCompany.get(l.companyId) ?? [];
    list.push({ personId: l.personId, companyId: l.companyId, accountant: ACCOUNTANT.test(l.role) || ACCOUNTANT.test(l.title ?? "") });
    byCompany.set(l.companyId, list);
  }
  const overrideByFlow = new Map(overrides.map((o) => [o.flowId, o.personId]));
  const sortKey = (id: string) => `${byId.get(id)?.fullName ?? ""}\u0000${id}`;

  const index: AskPeopleIndex = {
    person: (id) => (id ? (names.get(id) ?? null) : null),
    eligible: (flow, personId) =>
      !!personId && [flow.fromCompanyId, flow.toCompanyId].some((c) => (byCompany.get(c) ?? []).some((l) => l.personId === personId)),
    options: (flow) => {
      const ids = new Set([...(byCompany.get(flow.fromCompanyId) ?? []), ...(byCompany.get(flow.toCompanyId) ?? [])].map((l) => l.personId));
      return [...ids].sort((a, b) => sortKey(a).localeCompare(sortKey(b))).map((id) => names.get(id)!);
    },
    defaultFor: (flow) => {
      for (const companyId of [flow.fromCompanyId, flow.toCompanyId]) {
        const accountants = (byCompany.get(companyId) ?? []).filter((l) => l.accountant).map((l) => l.personId);
        if (accountants.length) return accountants.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))[0]!;
      }
      return null;
    },
    override: (flow) => {
      const id = overrideByFlow.get(flow.id);
      return id && index.eligible(flow, id) ? index.person(id) : null;
    },
    forMissing: (flow) => index.override(flow) ?? (index.eligible(flow, flow.askPersonId) ? index.person(flow.askPersonId) : null),
    forRequested: (flow, requestedPersonId) =>
      index.eligible(flow, requestedPersonId) ? index.person(requestedPersonId) : index.forMissing(flow),
  };
  return index;
}

/** The default "who to ask" for a new flow between these companies (seed, createFlow). */
export async function defaultAskPersonId(db: Db, fromCompanyId: string, toCompanyId: string): Promise<string | null> {
  return (await loadAskPeople(db, null)).defaultFor({ fromCompanyId, toCompanyId });
}
