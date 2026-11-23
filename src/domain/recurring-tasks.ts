import type { Entity, Task, Workspace } from "./model.js";
import { PlannerError } from "./model.js";
import { addDays, isDay, wallTime } from "./time.js";
import { recurrenceDates, recurrenceRuleSchema } from "./task-recurrence.js";
import type { RecurrenceRule, TaskRecurrence } from "./task-recurrence.js";

type NewEntity = () => Entity;
function schedule(
  state: Workspace,
  task: Task,
  series: TaskRecurrence,
  entity: NewEntity,
) {
  if (!series.rule.time) return;
  let startsAt: string;
  try {
    startsAt = wallTime(task.deadline!, series.rule.time, series.rule.timeZone);
  } catch {
    return;
  } // A nonexistent DST time remains an all-day task, never silently shifted.
  const block = {
    ...entity(),
    title: "",
    description: "",
    startsAt,
    endsAt: new Date(
      Date.parse(startsAt) + series.rule.duration * 60000,
    ).toISOString(),
    timeZone: series.rule.timeZone,
  };
  state.timeBlocks.push(block);
  state.blockTaskLinks.push({ timeBlockId: block.id, taskId: task.id });
}

export function attachRecurrence(
  state: Workspace,
  task: Task,
  input: RecurrenceRule,
  entity: NewEntity,
) {
  if (task.recurrenceId)
    throw new PlannerError(
      "invalid",
      "This task already belongs to a repeat schedule.",
    );
  const parsed = recurrenceRuleSchema.safeParse(input);
  if (!parsed.success)
    throw new PlannerError("invalid", parsed.error.issues[0].message);
  const rule = parsed.data;
  const first = recurrenceDates(
    rule,
    rule.startsOn,
    addDays(rule.startsOn, 366),
  )[0];
  if (!first)
    throw new PlannerError(
      "invalid",
      "No repeat date falls within this date range.",
    );
  const series: TaskRecurrence = {
    ...entity(),
    title: task.title,
    description: task.description,
    projectId: task.projectId,
    tags: task.tags || [],
    conditions: state.conditions
      .filter((c) => c.taskId === task.id)
      .sort((a, b) => a.position - b.position)
      .map((c) => c.description),
    rule,
    active: true,
    skippedOn: [],
  };
  state.taskRecurrences.push(series);
  Object.assign(task, {
    recurrenceId: series.id,
    scheduledOn: first,
    deadline: first,
  });
  schedule(state, task, series, entity);
  materializeRecurringTasks(state, first, addDays(first, 35), entity);
}

export function materializeRecurringTasks(
  state: Workspace,
  from: string,
  to: string,
  entity: NewEntity,
) {
  if (
    !isDay(from) ||
    !isDay(to) ||
    to < from ||
    Date.parse(to) - Date.parse(from) > 366 * 86400000
  )
    throw new PlannerError(
      "invalid",
      "Choose a repeat window of at most one year.",
    );
  const known = new Set(
    state.tasks
      .filter((t) => t.recurrenceId)
      .map((t) => `${t.recurrenceId}:${t.scheduledOn}`),
  );
  let position =
    Math.max(-1, ...state.tasks.map((t) => t.listPosition || 0)) + 1;
  let created = 0;
  let writes = 0;
  for (const series of state.taskRecurrences) {
    if (
      !series.active ||
      state.projects.some((p) => p.id === series.projectId && p.completedAt)
    )
      continue;
    const skipped = new Set(series.skippedOn);
    let generated = false;
    for (const day of recurrenceDates(series.rule, from, to)) {
      const key = `${series.id}:${day}`;
      if (known.has(key) || skipped.has(day)) continue;
      if (++created > 1000)
        throw new PlannerError(
          "invalid",
          "Too many repeating tasks in this range. Choose a shorter range.",
        );
      writes += 1 + series.conditions.length + (series.rule.time ? 2 : 0);
      if (writes > 4500)
        throw new PlannerError(
          "invalid",
          "Too many repeat details in this range. Choose a shorter date range.",
        );
      generated = true;
      const task: Task = {
        ...entity(),
        title: series.title,
        description: series.description,
        projectId: series.projectId,
        tags: [...series.tags],
        recurrenceId: series.id,
        scheduledOn: day,
        deadline: day,
        completedAt: null,
        startedAt: null,
        workStatus: "active",
        listPosition: position++,
        projectPosition:
          Math.max(
            -1,
            ...state.tasks
              .filter((t) => t.projectId === series.projectId)
              .map((t) => t.projectPosition || 0),
          ) + 1,
      };
      state.tasks.push(task);
      series.conditions.forEach((description, position) =>
        state.conditions.push({
          ...entity(),
          taskId: task.id,
          description,
          position,
          isMet: false,
        }),
      );
      schedule(state, task, series, entity);
      known.add(key);
    }
    // Guard the template read with the existing transaction revision check.
    // Concurrent stop/skip edits must win over a stale generation request.
    if (generated)
      series.updatedAt = new Date(
        Math.max(
          Date.parse(entity().updatedAt),
          Date.parse(series.updatedAt) + 1,
        ),
      ).toISOString();
  }
}
