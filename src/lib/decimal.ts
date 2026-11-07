/**
 * Exact decimal maths for numbers that come out of `numeric(…, 4)` columns (money, counts,
 * percentages). Values are BigInt "ten-thousandths": 1234567.89 → 12345678900n. No float is
 * ever used, so sums, differences and comparisons are exact and divisions are rounded once,
 * half away from zero, to 4 decimals (the stored precision).
 *
 * Pure, no imports: used by the finance rules, the AI roles service and the UI.
 */

export const SCALE = 4;
const ONE = 10n ** BigInt(SCALE);

/** A decimal as scaled BigInt (value × 10^4). */
export type Dec = bigint;

/** "1234567.89", "-12", "0.5", 42 → Dec. Throws on anything else (more than 4 decimals too). */
export function dec(v: string | number | bigint): Dec {
  if (typeof v === "bigint") return v * ONE;
  const s = typeof v === "number" ? numberText(v) : v.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Not a decimal: ${s}`);
  const frac = (m[3] ?? "").replace(/0+$/, "");
  if (frac.length > SCALE) throw new Error(`More than ${SCALE} decimals: ${s}`);
  const n = BigInt(m[2]!) * ONE + BigInt(frac.padEnd(SCALE, "0") || "0");
  return m[1] ? -n : n;
}

/** Text of a JS number without exponent (only for whole or short decimals from tests/config). */
function numberText(n: number): string {
  if (!Number.isFinite(n)) throw new Error("Not a finite number");
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(SCALE);
}

export const ZERO: Dec = 0n;

export function add(a: Dec, b: Dec): Dec {
  return a + b;
}

export function sub(a: Dec, b: Dec): Dec {
  return a - b;
}

export function abs(a: Dec): Dec {
  return a < 0n ? -a : a;
}

export function sum(values: readonly Dec[]): Dec {
  return values.reduce((s, v) => s + v, 0n);
}

/** Rounded integer division of scaled values, half away from zero. */
function roundDiv(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error("Division by zero");
  const neg = num < 0n !== den < 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = (n * 2n + d) / (2n * d);
  return neg ? -q : q;
}

/** a × b (4 decimals, rounded). */
export function mul(a: Dec, b: Dec): Dec {
  return roundDiv(a * b, ONE);
}

/** a ÷ b (4 decimals, rounded). Throws when b is 0 — callers check first. */
export function div(a: Dec, b: Dec): Dec {
  return roundDiv(a * ONE, b);
}

/** a ÷ n for a whole count n (averages). */
export function divInt(a: Dec, n: number): Dec {
  return roundDiv(a, BigInt(n));
}

/** (a − b) / |b| × 100, rounded to 4 decimals. Null when b is 0. */
export function pctChange(current: Dec, previous: Dec): Dec | null {
  if (previous === 0n) return null;
  return roundDiv((current - previous) * 100n * ONE, abs(previous));
}

/** a / b × 100 (a share in percent), 4 decimals. Null when b is 0. */
export function pctOf(part: Dec, whole: Dec): Dec | null {
  if (whole === 0n) return null;
  return roundDiv(part * 100n * ONE, whole);
}

/**
 * Exact threshold test without dividing: |current − previous| × 100 ≥ threshold% × |previous|.
 * False when previous is 0 (no percentage change exists).
 */
export function changeAtLeast(current: Dec, previous: Dec, thresholdPct: Dec): boolean {
  if (previous === 0n) return false;
  return abs(current - previous) * 100n * ONE >= thresholdPct * abs(previous);
}

export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Plain text, shortest form: 12345678900n → "1234567.89". */
export function toText(a: Dec): string {
  const neg = a < 0n;
  const n = neg ? -a : a;
  const whole = n / ONE;
  const frac = (n % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Rounds to `places` decimals (half away from zero) and returns plain text with exactly that many. */
export function toFixed(a: Dec, places: number): string {
  const step = 10n ** BigInt(SCALE - places);
  const r = roundDiv(a, step);
  const neg = r < 0n;
  const n = neg ? -r : r;
  const p = 10n ** BigInt(places);
  const whole = n / p;
  const frac = places > 0 ? `.${(n % p).toString().padStart(places, "0")}` : "";
  return `${neg && r !== 0n ? "-" : ""}${whole}${frac}`;
}

/**
 * For display: "1 234 567.89 KGS", "95.5%", "120 orders" — Russian digit grouping with a
 * thin space, at most `maxDecimals` (default 2; 1 for %), trailing zeros dropped.
 */
export function formatDec(a: Dec, unit?: string, maxDecimals?: number): string {
  const places = maxDecimals ?? (unit === "%" ? 1 : 2);
  const fixed = toFixed(a, places);
  const neg = fixed.startsWith("-");
  const [w, f] = fixed.replace(/^-/, "").split(".");
  const grouped = w!.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const frac = f ? f.replace(/0+$/, "") : "";
  const n = `${neg ? "−" : ""}${grouped}${frac ? `.${frac}` : ""}`;
  if (!unit || unit === "count") return n;
  if (unit === "%") return `${n}%`;
  return `${n} ${unit}`;
}

/** Percentage for sentences: one decimal, no sign ("32.5%"). */
export function formatPct(p: Dec): string {
  return `${formatDec(abs(p), undefined, 1)}%`;
}
