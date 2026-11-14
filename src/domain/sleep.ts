import type { SleepRecord } from "./model.js";
import { dayKey, minutesBetween } from "./time.js";

export function sleepMinutes(
  record: Pick<SleepRecord, "startsAt" | "endsAt" | "awakeMinutes">,
) {
  return Math.max(
    0,
    minutesBetween(record.startsAt, record.endsAt) - record.awakeMinutes,
  );
}

/** A completed sleep belongs to its waking date in its recorded time zone. */
export function sleepOnDay(records: SleepRecord[], day: string) {
  return records
    .filter(
      (record) => dayKey(new Date(record.endsAt), record.timeZone) === day,
    )
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
