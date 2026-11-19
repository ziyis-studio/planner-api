import { z } from "zod";
import type { Habit, Workspace } from "./domain/model.js";
import type {
  HabitInsightDay,
  HabitInsights,
  SleepInsights,
} from "./domain/insights.js";
import {
  addDays,
  dayKey,
  isDay,
  isoWeekday,
  isTimeZone,
  minutesBetween,
  timeKey,
} from "./domain/time.js";

export const insightQuery = z
  .strictObject({
    kind: z.enum(["sleep", "habits"]),
    from: z.string().refine(isDay),
    to: z.string().refine(isDay),
    zone: z.string().max(100).refine(isTimeZone),
  })
  .refine(
    (q) =>
      q.from <= q.to && Date.parse(q.to) - Date.parse(q.from) <= 365 * 86400000,
    "Choose a range of up to one year.",
  );

export function habitInsights(
  workspace: Workspace,
  from: string,
  to: string,
  today: string,
): HabitInsights {
  const executions = new Map(
    workspace.executions.map((e) => [e.occurrenceId, e]),
  );
  const planned = new Map<string, typeof workspace.occurrences>();
  const scheduled = new Set<string>();
  for (const occurrence of workspace.occurrences) {
    const key = occurrence.habitId + ":" + occurrence.plannedOn;
    const members = planned.get(key) || [];
    members.push(occurrence);
    planned.set(key, members);
    scheduled.add(occurrence.habitId + ":" + occurrence.scheduledOn);
  }
  const count = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const dates = Array.from({ length: count }, (_, i) => addDays(from, i));
  function day(habit: Habit, date: string): HabitInsightDay {
    const key = habit.id + ":" + date;
    const occurrences = planned.get(key) || [];
    const needsMaterialization =
      date >= habit.startsOn &&
      (!habit.endsOn || date <= habit.endsOn) &&
      habit.isoWeekdays.includes(isoWeekday(date)) &&
      !scheduled.has(key);
    const due = occurrences.length + Number(needsMaterialization);
    const done = occurrences.filter((o) => executions.has(o.id));
    return {
      date,
      planned: due,
      completed: done.length,
      needsMaterialization,
      level: !due ? 0 : !done.length ? 1 : done.length < due ? 2 : 3,
      actualDates: [
        ...new Set(done.map((o) => executions.get(o.id)!.performedOn)),
      ],
    };
  }
  const asOf = to < today ? to : today;
  const habits = workspace.habits.map((habit) => {
    const days = dates.map((date) => day(habit, date));
    let run = 0,
      bestStreak = 0;
    for (const d of days) {
      if (d.date > today || !d.planned) continue;
      if (d.completed === d.planned) bestStreak = Math.max(bestStreak, ++run);
      else run = 0;
    }
    let currentStreak = 0;
    const earliest = workspace.occurrences
      .filter((o) => o.habitId === habit.id)
      .reduce(
        (first, o) => (o.plannedOn < first ? o.plannedOn : first),
        habit.startsOn,
      );
    if (
      asOf >= earliest &&
      workspace.occurrences.some(
        (o) => o.habitId === habit.id && executions.has(o.id),
      )
    ) {
      for (let date = asOf; date >= earliest; date = addDays(date, -1)) {
        const d = day(habit, date);
        if (!d.planned) continue;
        // Today is still open; an incomplete day breaks a streak after it ends.
        if (date === today && d.completed < d.planned) continue;
        if (d.completed !== d.planned) break;
        currentStreak++;
      }
    }
    const due = days.filter((d) => d.date <= today);
    return {
      id: habit.id,
      days,
      currentStreak,
      bestStreak,
      completed: due.reduce((n, d) => n + d.completed, 0),
      planned: due.reduce((n, d) => n + d.planned, 0),
    };
  });
  const daily = dates.map((date, i) => {
    const values = habits.map((h) => h.days[i]);
    const planned = values.reduce((n, d) => n + d.planned, 0),
      completed = values.reduce((n, d) => n + d.completed, 0);
    return {
      date,
      planned,
      completed,
      needsMaterialization: false,
      level: !planned ? 0 : !completed ? 1 : completed < planned ? 2 : 3,
      actualDates: [],
    };
  });
  const completed = habits.reduce((n, h) => n + h.completed, 0),
    total = habits.reduce((n, h) => n + h.planned, 0);
  const strongest = [...habits].sort(
    (a, b) => b.currentStreak - a.currentStreak || b.bestStreak - a.bestStreak,
  )[0];
  const streakHabit =
    strongest && workspace.habits.find((h) => h.id === strongest.id);
  return {
    kind: "habits",
    from,
    to,
    today,
    completed,
    planned: total,
    percentage: total ? Math.round((completed / total) * 100) : 0,
    perfectDays: daily.filter(
      (d) => d.date <= today && d.planned > 0 && d.planned === d.completed,
    ).length,
    activeDays: daily.filter((d) => d.date <= today && d.completed > 0).length,
    currentStreak: strongest?.currentStreak || 0,
    bestStreak: Math.max(0, ...habits.map((h) => h.bestStreak)),
    streakHabit: streakHabit?.title || null,
    daily,
    habits,
    trail:
      strongest && streakHabit
        ? Array.from({ length: 14 }, (_, i) =>
            day(streakHabit, addDays(asOf, i - 13)),
          )
        : [],
  };
}

const minuteOfDay = (instant: string, zone: string) => {
  const [h, m] = timeKey(instant, zone).split(":").map(Number);
  return h * 60 + m;
};
const clock = (minute: number) => {
  const n = ((Math.round(minute) % 1440) + 1440) % 1440;
  return (
    String(Math.floor(n / 60)).padStart(2, "0") +
    ":" +
    String(n % 60).padStart(2, "0")
  );
};
function clockMean(values: number[]) {
  const angles = values.map((value) => (value / 1440) * Math.PI * 2);
  const sin = angles.reduce((sum, angle) => sum + Math.sin(angle), 0);
  const cos = angles.reduce((sum, angle) => sum + Math.cos(angle), 0);
  // Opposing or evenly distributed times have no meaningful single mean.
  if (!values.length || Math.hypot(sin, cos) / values.length < 1e-6)
    return null;
  return ((Math.atan2(sin, cos) * 1440) / (Math.PI * 2) + 1440) % 1440;
}
export function sleepInsights(
  workspace: Workspace,
  from: string,
  to: string,
  today: string,
  zone: string,
): SleepInsights {
  const groups = new Map<string, typeof workspace.sleepRecords>();
  for (const record of workspace.sleepRecords) {
    const date = dayKey(record.endsAt, zone);
    if (date < from || date > to || date > today) continue;
    const group = groups.get(date) || [];
    group.push(record);
    groups.set(date, group);
  }
  const days = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, records]) => ({
      date,
      entries: records.length,
      minutes: Math.round(
        records.reduce(
          (n, r) =>
            n +
            Math.max(0, minutesBetween(r.startsAt, r.endsAt) - r.awakeMinutes),
          0,
        ),
      ),
      awake: records.reduce((n, r) => n + r.awakeMinutes, 0),
      inBed: Math.round(
        records.reduce((n, r) => n + minutesBetween(r.startsAt, r.endsAt), 0),
      ),
    }));
  const primary = [...groups.values()].map(
    (records) =>
      [...records].sort(
        (a, b) =>
          minutesBetween(b.startsAt, b.endsAt) -
          minutesBetween(a.startsAt, a.endsAt),
      )[0],
  );
  const beds = primary.map((r) => minuteOfDay(r.startsAt, zone));
  const wakes = primary.map((r) => minuteOfDay(r.endsAt, zone));
  const bedtime = clockMean(beds),
    wakeTime = clockMean(wakes);
  const mean = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
  const recent = days.at(-1),
    records = recent
      ? [...groups.get(recent.date)!].sort((a, b) =>
          a.startsAt.localeCompare(b.startsAt),
        )
      : [];
  const elapsedEnd = to < today ? to : today;
  return {
    kind: "sleep",
    from,
    to,
    today,
    days,
    average: days.length ? Math.round(mean(days.map((d) => d.minutes))) : null,
    loggedDays: days.length,
    elapsedDays:
      elapsedEnd < from
        ? 0
        : Math.round((Date.parse(elapsedEnd) - Date.parse(from)) / 86400000) +
          1,
    shortest: days.length ? Math.min(...days.map((d) => d.minutes)) : null,
    longest: days.length ? Math.max(...days.map((d) => d.minutes)) : null,
    rhythm:
      bedtime !== null && wakeTime !== null
        ? {
            bedtime: clock(bedtime),
            wakeTime: clock(wakeTime),
            variation: Math.round(
              mean(
                beds.map((v) =>
                  Math.min(Math.abs(v - bedtime), 1440 - Math.abs(v - bedtime)),
                ),
              ),
            ),
            samples: primary.length,
          }
        : null,
    recent: recent
      ? {
          ...recent,
          bedtime: timeKey(records[0].startsAt, zone),
          wakeTime: timeKey(
            [...records]
              .sort((a, b) => a.endsAt.localeCompare(b.endsAt))
              .at(-1)!.endsAt,
            zone,
          ),
          difference:
            days.length > 1 ? recent.minutes - days.at(-2)!.minutes : null,
          records: records.map((r) => ({
            id: r.id,
            startsAt: r.startsAt,
            endsAt: r.endsAt,
            minutes: Math.round(
              Math.max(
                0,
                minutesBetween(r.startsAt, r.endsAt) - r.awakeMinutes,
              ),
            ),
            awake: r.awakeMinutes,
          })),
        }
      : null,
  };
}
export function workspaceInsights(
  workspace: Workspace,
  query: z.infer<typeof insightQuery>,
  now = new Date(),
) {
  const today = dayKey(now, query.zone);
  return query.kind === "habits"
    ? habitInsights(workspace, query.from, query.to, today)
    : sleepInsights(workspace, query.from, query.to, today, query.zone);
}
