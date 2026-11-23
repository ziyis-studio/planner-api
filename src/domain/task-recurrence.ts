import { z } from "zod";
import type { Entity } from "./model.js";
import { addDays, isDay, isTime, isTimeZone } from "./time.js";

const day = z.string().refine(isDay, "Choose a valid date.");
export const recurrenceRuleSchema = z
  .strictObject({
    frequency: z.enum(["daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(12),
    startsOn: day,
    endsOn: day.nullable(),
    monthDay: z.union([z.literal("last"), z.number().int().min(1).max(31)]),
    time: z.string().refine(isTime).nullable(),
    duration: z.number().int().min(5).max(1440),
    timeZone: z.string().refine(isTimeZone),
  })
  .refine((r) => !r.endsOn || r.endsOn >= r.startsOn, {
    message: "Repeat end date must be on or after its start date.",
  });
export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;
export const recurrenceRecordSchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10000),
  projectId: z.uuid().nullable(),
  tags: z.array(z.string().min(1).max(40)).max(30),
  conditions: z.array(z.string().min(1).max(10000)).max(1000),
  rule: recurrenceRuleSchema,
  active: z.boolean(),
  skippedOn: z.array(day).max(10000),
});
export interface TaskRecurrence
  extends Entity, Omit<z.infer<typeof recurrenceRecordSchema>, keyof Entity> {}

/** Calendar arithmetic never advances from the previous month's clamped date. */
export function recurrenceDates(
  rule: RecurrenceRule,
  from: string,
  to: string,
): string[] {
  if (!isDay(from) || !isDay(to) || to < from) return [];
  const start = rule.startsOn > from ? rule.startsOn : from;
  const end = rule.endsOn && rule.endsOn < to ? rule.endsOn : to;
  const result: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const elapsed = Math.round(
      (Date.parse(day) - Date.parse(rule.startsOn)) / 86400000,
    );
    if (rule.frequency !== "monthly") {
      if (
        elapsed % (rule.interval * (rule.frequency === "weekly" ? 7 : 1)) ===
        0
      )
        result.push(day);
    } else {
      const [y, m, d] = day.split("-").map(Number);
      const [sy, sm] = rule.startsOn.split("-").map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      if (
        ((y - sy) * 12 + m - sm) % rule.interval === 0 &&
        d === (rule.monthDay === "last" ? last : Math.min(rule.monthDay, last))
      )
        result.push(day);
    }
  }
  return result;
}

export function recurrenceLabel(rule: RecurrenceRule): string {
  const every = rule.interval === 1 ? "Every" : `Every ${rule.interval}`;
  if (rule.frequency === "monthly")
    return `${every} ${rule.interval === 1 ? "month" : "months"} · ${rule.monthDay === "last" ? "last day" : `day ${rule.monthDay}`}`;
  return `${every} ${rule.frequency === "daily" ? (rule.interval === 1 ? "day" : "days") : rule.interval === 1 ? "week" : "weeks"}`;
}
