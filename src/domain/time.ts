import { TZDate } from "@date-fns/tz";
import { PlannerError } from "./model.js";

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = locale + JSON.stringify(options);
  let value = formatters.get(key);
  if (!value) {
    value = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= 32)
      formatters.delete(formatters.keys().next().value!);
    formatters.set(key, value);
  }
  return value;
}

export function isTimeZone(value: string): boolean {
  try {
    formatter("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
export function isTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
export function dayKey(value: Date | string, timeZone: string): string {
  const parts = formatter("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function timeKey(value: Date | string, timeZone: string): string {
  return formatter("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
export function addDays(day: string, amount: number): string {
  if (!isDay(day)) throw new PlannerError("invalid", "Choose a valid date.");
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + amount, 12))
    .toISOString()
    .slice(0, 10);
}
export function isoWeekday(day: string): number {
  if (!isDay(day)) throw new PlannerError("invalid", "Choose a valid date.");
  return new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
}
export function weekDays(day: string, startsOn: 1 | 7 = 1): string[] {
  const offset = (isoWeekday(day) - startsOn + 7) % 7;
  return Array.from({ length: 7 }, (_, index) => addDays(day, index - offset));
}
export function addMonths(day: string, amount: number): string {
  if (!isDay(day) || !Number.isInteger(amount))
    throw new PlannerError("invalid", "Choose a valid date.");
  const [year, month, date] = day.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + amount, 1, 12));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12),
  );
  target.setUTCDate(Math.min(date, last.getUTCDate()));
  return target.toISOString().slice(0, 10);
}
/** Six complete weeks keep the month layout stable, respecting the chosen week start. */
export function monthDays(day: string, startsOn: 1 | 7 = 1): string[] {
  if (!isDay(day)) throw new PlannerError("invalid", "Choose a valid date.");
  const start = weekDays(`${day.slice(0, 7)}-01`, startsOn)[0];
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}
export function wallTime(day: string, clock: string, timeZone: string): string {
  if (!isDay(day) || !isTime(clock) || !isTimeZone(timeZone))
    throw new PlannerError(
      "invalid",
      "Choose a valid date, time and time zone.",
    );
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = clock.split(":").map(Number);
  const value = new TZDate(year, month - 1, date, hour, minute, 0, timeZone);
  // Reject a nonexistent DST wall time rather than silently shifting a user's plan.
  if (dayKey(value, timeZone) !== day || timeKey(value, timeZone) !== clock)
    throw new PlannerError(
      "invalid",
      "That time does not exist in this time zone. Choose another time.",
    );
  return value.toISOString();
}
export function dayBounds(day: string, timeZone: string): [number, number] {
  return [
    new Date(wallTime(day, "00:00", timeZone)).valueOf(),
    new Date(wallTime(addDays(day, 1), "00:00", timeZone)).valueOf(),
  ];
}
export function minutesBetween(start: string, end: string): number {
  return Math.round(
    (new Date(end).valueOf() - new Date(start).valueOf()) / 60_000,
  );
}
export function addMinutes(value: string, minutes: number): string {
  return new Date(new Date(value).valueOf() + minutes * 60_000).toISOString();
}
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60),
    remainder = minutes % 60;
  return `${hours ? `${hours} h` : ""}${hours && remainder ? " " : ""}${remainder || !hours ? `${remainder} min` : ""}`;
}
export function dateLabel(
  day: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
): string {
  return formatter("en", { timeZone: "UTC", ...options }).format(
    new Date(`${day}T12:00:00Z`),
  );
}
