/**
 * Working hours for estimates (0034): 1 estimate point = 1 working hour. Working time is the
 * staff work window of Settings → Team on Telegram (the person's own window when they have one),
 * Monday to Saturday, in the app's time zone (Asia/Bishkek). Pure: no database, no clock.
 */
import { addDays, isoWeekday, todayInTimeZone, zonedTimeToUtc, type HmTime, type IsoDate } from "./dates";

export interface WorkWindow {
  workStart: HmTime;
  workEnd: HmTime;
  timeZone: string;
  /** ISO weekdays that are working days (1 = Monday … 7 = Sunday). Default Monday–Saturday. */
  days?: readonly number[];
}

export const WORK_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6];
/** Longest stretch looked at (a task in progress for months is over any estimate anyway). */
const MAX_DAYS = 120;

/** Working minutes between two instants (0 when `to` is not after `from`). */
export function workingMinutesBetween(from: Date, to: Date, w: WorkWindow): number {
  if (to.getTime() <= from.getTime()) return 0;
  const days = w.days ?? WORK_DAYS;
  let day: IsoDate = todayInTimeZone(from, w.timeZone);
  const last: IsoDate = todayInTimeZone(to, w.timeZone);
  let total = 0;
  for (let i = 0; i <= MAX_DAYS && day <= last; i++, day = addDays(day, 1)) {
    if (!days.includes(isoWeekday(day))) continue;
    const start = zonedTimeToUtc(day, w.workStart, w.timeZone).getTime();
    const end = zonedTimeToUtc(day, w.workEnd, w.timeZone).getTime();
    const a = Math.max(start, from.getTime());
    const b = Math.min(end, to.getTime());
    if (b > a) total += (b - a) / 60_000;
  }
  return Math.floor(total);
}

/** In progress longer than its estimate (points = hours of working time)? */
export function isOverEstimate(
  t: { status: string; estimate: number | null; startedAt: Date | null },
  now: Date,
  w: WorkWindow,
): boolean {
  if (t.status !== "in_progress" || !t.estimate || !t.startedAt) return false;
  return workingMinutesBetween(t.startedAt, now, w) > t.estimate * 60;
}
