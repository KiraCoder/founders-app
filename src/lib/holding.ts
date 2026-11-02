/**
 * Pure rules for the Holding page: which months need an акт, the colour of each grid
 * cell, debts between companies (netted per pair) and contract expiry warnings, plus the
 * texts that ask Elmurat for missing акты. No DB, no clock: callers pass `today` (the
 * calendar day in Asia/Bishkek), so every rule is testable.
 */
import { addDays, daysBetween, type IsoDate } from "./dates";
import { nextPeriod, periodEnd, prevPeriod } from "./metrics";

export const ACT_STATUSES = ["missing", "requested", "received", "signed", "not_needed"] as const;
export type ActStatusValue = (typeof ACT_STATUSES)[number];
export const CONTRACT_STATUSES = ["draft", "signed", "expired", "terminated"] as const;
export type ContractStatusValue = (typeof CONTRACT_STATUSES)[number];
export const FLOW_STATUSES = ["active", "planned"] as const;
export type FlowStatusValue = (typeof FLOW_STATUSES)[number];

export const ACT_STATUS_LABELS: Record<ActStatusValue, string> = {
  missing: "Missing",
  requested: "Requested",
  received: "Received",
  signed: "Signed",
  not_needed: "Not needed",
};

export const CONTRACT_STATUS_LABELS: Record<ContractStatusValue, string> = {
  draft: "Draft",
  signed: "Signed",
  expired: "Expired",
  terminated: "Terminated",
};

/**
 * Days into the next month before a month's акт is expected (Elmurat needs time to close
 * the month). With 10, October is expected from 11 November. Env HOLDING_ACTS_GRACE_DAYS.
 */
export const DEFAULT_GRACE_DAYS = 10;
/** Contracts ending within this many days are flagged. */
export const CONTRACT_WARN_DAYS = 30;
/** A requested акт still not received after this many days gets one reminder line (Mondays). */
export const REMINDER_AFTER_DAYS = 7;
/** Grid default: the last 12 finished months + the current month. */
export const GRID_MONTHS = 13;

export function graceDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.HOLDING_ACTS_GRACE_DAYS);
  return Number.isInteger(n) && n >= 0 && n <= 27 ? n : DEFAULT_GRACE_DAYS;
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Months in Russian, nominative ("за сентябрь" is accusative = nominative for months). */
const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

export function monthStart(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

/** The first day `month`'s акт is expected: the 1st of the next month + grace days. */
export function actDueFrom(month: IsoDate, grace: number): IsoDate {
  return addDays(nextPeriod(monthStart(month), "month"), grace);
}

/** "Oct" or "Oct 25" (with year when it differs from `refYear`). */
export function monthShort(month: IsoDate, refYear?: string): string {
  const m = MONTHS_EN[Number(month.slice(5, 7)) - 1]!;
  return refYear && month.slice(0, 4) !== refYear ? `${m} ${month.slice(2, 4)}` : m;
}

export function monthLong(month: IsoDate): string {
  return `${MONTHS_EN[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** Grid months, oldest first: `count` months ending with the current one. */
export function gridMonths(today: IsoDate, count = GRID_MONTHS): IsoDate[] {
  const out: IsoDate[] = [];
  let m = monthStart(today);
  for (let i = 0; i < count; i++) {
    out.unshift(m);
    m = prevPeriod(m, "month");
  }
  return out;
}

export interface FlowTiming {
  status: FlowStatusValue;
  since: IsoDate | null;
  until: IsoDate | null;
  archived?: boolean;
}

/** Why a month is or is not expected for a flow. */
export type Expectation =
  | "expected"
  /** Flow planned, archived, or its start date is not set yet. */
  | "inactive"
  | "before_start"
  | "after_end"
  /** The month is not finished yet, or still inside the grace days. */
  | "not_due";

export function expectation(flow: FlowTiming, month: IsoDate, today: IsoDate, grace: number): Expectation {
  if (flow.archived || flow.status !== "active" || !flow.since) return "inactive";
  const m = monthStart(month);
  if (m < monthStart(flow.since)) return "before_start";
  if (flow.until && m > monthStart(flow.until)) return "after_end";
  if (today < actDueFrom(m, grace)) return "not_due";
  return "expected";
}

/**
 * What a grid cell shows. A recorded status always wins (an акт received early is
 * received); without one, an expected month is missing (red), anything else is grey.
 */
export type CellState = "signed" | "received" | "requested" | "missing" | "not_needed" | "before_start" | "after_end" | "not_due" | "inactive";
export type CellTone = "ok" | "warn" | "risk" | "grey" | "upcoming";

export function cellState(recorded: ActStatusValue | null, exp: Expectation): CellState {
  if (recorded && recorded !== "missing") return recorded;
  if (exp === "expected") return "missing";
  return exp;
}

export function cellTone(state: CellState): CellTone {
  switch (state) {
    case "signed":
    case "received":
      return "ok";
    case "requested":
      return "warn";
    case "missing":
      return "risk";
    case "not_due":
      return "upcoming";
    default:
      return "grey";
  }
}

export const CELL_STATE_LABELS: Record<CellState, string> = {
  signed: "Signed",
  received: "Received",
  requested: "Requested",
  missing: "Missing",
  not_needed: "Not needed",
  before_start: "Before the flow started",
  after_end: "After the flow ended",
  not_due: "Not due yet",
  inactive: "No акты expected",
};

// ---------------------------------------------------------------------------
// Debts between companies
// ---------------------------------------------------------------------------

/** One movement: `debtor` owes `creditor` +amount (an акт, an opening balance) or −amount (a payment). */
export interface DebtMovement {
  debtor: string;
  creditor: string;
  /** Positive: debt grows; negative: debt shrinks (payment). */
  amount: number;
  date: IsoDate;
}

export interface PairDebt {
  /** The company that owes (after netting both directions). */
  debtor: string;
  creditor: string;
  /** Net amount, > 0. */
  amount: number;
}

/** Cents, so sums of 2-decimal amounts stay exact. */
const toCents = (n: number) => Math.round(n * 100);

/**
 * Nets every pair of companies: what A owes B minus what B owes A. Only movements on or
 * before `asOf` count. Pairs that net to zero are left out. Sorted by amount, largest first.
 */
export function netDebts(movements: readonly DebtMovement[], asOf?: IsoDate): PairDebt[] {
  const byPair = new Map<string, number>();
  for (const m of movements) {
    if (asOf && m.date > asOf) continue;
    if (m.debtor === m.creditor) continue;
    const [a, b] = m.debtor < m.creditor ? [m.debtor, m.creditor] : [m.creditor, m.debtor];
    const key = `${a}|${b}`;
    // Positive = a owes b.
    const signed = m.debtor === a ? toCents(m.amount) : -toCents(m.amount);
    byPair.set(key, (byPair.get(key) ?? 0) + signed);
  }
  const out: PairDebt[] = [];
  for (const [key, cents] of byPair) {
    if (cents === 0) continue;
    const [a, b] = key.split("|") as [string, string];
    out.push(cents > 0 ? { debtor: a, creditor: b, amount: cents / 100 } : { debtor: b, creditor: a, amount: -cents / 100 });
  }
  return out.sort((x, y) => y.amount - x.amount || x.debtor.localeCompare(y.debtor));
}

/** Sum of the netted debts (each pair counted once). */
export function totalDebt(pairs: readonly PairDebt[]): number {
  return pairs.reduce((s, p) => s + toCents(p.amount), 0) / 100;
}

/**
 * The date an акт's amount counts from: its act date, else the last day of its month.
 * Only acts received or signed count as invoiced.
 */
export function actCountsAsInvoiced(status: ActStatusValue): boolean {
  return status === "received" || status === "signed";
}

export function actLedgerDate(period: IsoDate, actDate: IsoDate | null): IsoDate {
  return actDate ?? periodEnd(monthStart(period), "month");
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type ContractWarning =
  | { kind: "expiring"; days: number }
  | { kind: "overdue"; days: number }
  | null;

/**
 * Signed contracts ending within CONTRACT_WARN_DAYS are "expiring"; signed contracts whose
 * end date has passed are "overdue" (still marked signed: renew or mark as expired).
 * Drafts, expired and terminated contracts get no warning.
 */
export function contractWarning(
  c: { status: ContractStatusValue; validUntil: IsoDate | null },
  today: IsoDate,
  warnDays = CONTRACT_WARN_DAYS,
): ContractWarning {
  if (c.status !== "signed" || !c.validUntil) return null;
  const days = daysBetween(today, c.validUntil);
  if (days < 0) return { kind: "overdue", days: -days };
  if (days <= warnDays) return { kind: "expiring", days };
  return null;
}

export function contractWarningText(w: ContractWarning): string | null {
  if (!w) return null;
  if (w.kind === "overdue") return `Ended ${w.days} day${w.days === 1 ? "" : "s"} ago — renew or mark as expired`;
  if (w.days === 0) return "Ends today";
  return `Ends in ${w.days} day${w.days === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Asking Elmurat
// ---------------------------------------------------------------------------

export interface AskGroup {
  /** "Alura Style → Alura Brand" */
  label: string;
  /** Russian service name for the copyable message ("пошив"). */
  service: string;
  months: IsoDate[];
}

/** Months in order, grouped "Sep, Oct" or "Dec 25, Jan" when years differ from `today`'s. */
function monthList(months: readonly IsoDate[], today: IsoDate): string {
  return [...months].sort().map((m) => monthShort(m, today.slice(0, 4))).join(", ");
}

export function countMonths(groups: readonly AskGroup[]): number {
  return groups.reduce((n, g) => n + g.months.length, 0);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Alura Style → Alura Brand (Sep, Oct), Jobutify → Kiwi Go (Oct) +1 more" — at most `max` flows. */
export function groupsText(groups: readonly AskGroup[], today: IsoDate, max = 3): string {
  const shown = groups.slice(0, max).map((g) => `${g.label} (${monthList(g.months, today)})`);
  return `${shown.join(", ")}${groups.length > max ? ` +${groups.length - max} more` : ""}`;
}

/** The one grouped morning-summary line for missing акты. */
export function askLine(groups: readonly AskGroup[], today: IsoDate): string {
  return `Ask Elmurat for ${plural(countMonths(groups), "missing акт", "missing акты")}: ${groupsText(groups, today)}`;
}

/** The one reminder line for акты asked for a week ago and still not received. */
export function reminderLine(groups: readonly AskGroup[], today: IsoDate, askedOn: IsoDate | null): string {
  const since = askedOn ? ` (asked ${Number(askedOn.slice(8, 10))} ${monthShort(askedOn)})` : "";
  return `Still waiting for ${plural(countMonths(groups), "акт", "акты")} from Elmurat${since}: ${groupsText(groups, today)}`;
}

function monthsRu(months: readonly IsoDate[]): string {
  const sorted = [...months].sort();
  const byYear = new Map<string, string[]>();
  for (const m of sorted) byYear.set(m.slice(0, 4), [...(byYear.get(m.slice(0, 4)) ?? []), MONTHS_RU[Number(m.slice(5, 7)) - 1]!]);
  return [...byYear.entries()].map(([y, names]) => `${names.join(", ")} ${y}`).join("; ");
}

/**
 * The message a founder can copy and send to Elmurat themselves. The app never sends it:
 * it only shows it with a copy button.
 */
export function elmuratMessage(groups: readonly AskGroup[]): string {
  if (!groups.length) return "";
  const lines = groups.map((g) => `— ${g.label}${g.service ? ` (${g.service})` : ""}: ${monthsRu(g.months)}`);
  return ["Элмурат, здравствуйте!", "Пришлите, пожалуйста, акты приёма-передачи за:", ...lines, "Спасибо!"].join("\n");
}
