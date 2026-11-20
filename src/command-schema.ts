import { z } from "zod";
import { mealFieldsSchema } from "./domain/meals.js";
import type { Command } from "./domain/commands.js";
import {
  databaseFieldsSchema,
  databaseValuesSchema,
} from "./domain/note-databases.js";
import { isDay, isTimeZone } from "./domain/time.js";
import { habitIconNames } from "./domain/habit-icons.js";
import { projectIconNames } from "./domain/project-icons.js";
const id = z.uuid(),
  ids = z.array(id).max(1000),
  title = z.string().trim().min(1).max(300),
  text = z.string().max(500000),
  short = z.string().max(10000),
  day = z.string().refine(isDay),
  timestamp = z.string().datetime({ offset: true }),
  revision = z.string().min(1).max(100),
  tags = z.array(z.string().trim().max(80)).max(50);
const object = z.strictObject;
const project = object({
  title,
  description: short.optional(),
  icon: z.enum(projectIconNames).nullable().optional(),
  tags: tags.optional(),
  workStatus: z.enum(["active", "on_hold"]).optional(),
});
const task = object({
  title,
  description: short.optional(),
  deadline: day.nullable().optional(),
  projectId: id.nullable().optional(),
  tags: tags.optional(),
  workStatus: z.enum(["active", "on_hold"]).optional(),
});
const thought = object({
  title: z.string().max(300).optional(),
  content: text,
  emotion: z.string().max(80).nullable().optional(),
});
const habit = object({
  title,
  description: short.optional(),
  icon: z.enum(habitIconNames).nullable().optional(),
  timeZone: z.string().refine(isTimeZone),
  startsOn: day,
  endsOn: day.nullable().optional(),
  isoWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
});
const save = { id: id.optional(), expectedUpdatedAt: revision.optional() };
const edit = { id, expectedUpdatedAt: revision.optional() };
const schemas = {
  "meal.save": object({ ...save, input: mealFieldsSchema }),
  "meal.delete": object({ id, expectedUpdatedAt: revision }),
  "task.move": object({
    id,
    stage: z.enum(["todo", "progress", "hold", "done"]),
    beforeId: id.nullable().optional(),
    items: z
      .array(object({ id, updatedAt: revision }))
      .max(1000)
      .optional(),
    expectedUpdatedAt: revision,
  }),
  "project.move": object({
    id,
    stage: z.enum(["progress", "hold", "done"]),
    beforeId: id.nullable().optional(),
    items: z
      .array(object({ id, updatedAt: revision }))
      .max(1000)
      .optional(),
    expectedUpdatedAt: revision,
  }),
  "task.reorder": object({
    items: z.array(object({ id, updatedAt: revision })).max(1000),
  }),
  "project.reorder": object({
    items: z.array(object({ id, updatedAt: revision })).max(1000),
  }),
  "task.create": object({
    input: task.extend({
      initialStage: z.enum(["todo", "progress", "hold", "done"]).optional(),
      conditions: z.array(short).max(1000).optional(),
      sourceThoughtIds: ids.optional(),
    }),
  }),
  "task.update": object({ ...edit, patch: task.partial() }),
  "task.delete": object({ id }),
  "task.complete": object(edit),
  "task.reopen": object(edit),
  "task.continue": object(edit),
  "condition.add": object({ taskId: id, description: short }),
  "condition.update": object({
    id,
    patch: object({
      description: short.optional(),
      isMet: z.boolean().optional(),
    }),
  }),
  "condition.delete": object({ id }),
  "project.create": object({
    input: project.extend({
      initialStage: z.enum(["progress", "hold", "done"]).optional(),
    }),
  }),
  "project.update": object({ ...edit, input: project }),
  "project.delete": object({ id }),
  "project.complete": object({ id }),
  "project.reopen": object({ id }),
  "project.reorderTasks": object({
    projectId: id,
    items: z.array(object({ id, updatedAt: revision })).max(1000),
  }),
  "task.reorderConditions": object({
    taskId: id,
    items: z.array(object({ id, updatedAt: revision })).max(1000),
  }),
  "thought.create": object({
    input: thought.extend({ recordedAt: timestamp.optional() }),
  }),
  "thought.update": object({ ...edit, input: thought }),
  "thought.delete": object({ id }),
  "thought.convert": object({
    thoughtIds: ids,
    kind: z.enum(["task", "project"]),
    input: project,
  }),
  "thought.link": object({
    thoughtIds: ids,
    kind: z.enum(["task", "project"]),
    targetId: id,
  }),
  "thought.unlink": object({
    thoughtIds: ids,
    kind: z.enum(["task", "project"]),
    targetId: id,
  }),
  "habit.create": object({ input: habit }),
  "habit.update": object({ ...edit, input: habit }),
  "habit.delete": object(edit),
  "occurrences.materialize": object({ from: day, to: day }).refine(
    (v) =>
      v.to >= v.from &&
      (new Date(v.to).valueOf() - new Date(v.from).valueOf()) / 86400000 <= 366,
    "Use a date range of at most 367 days.",
  ),
  "occurrence.reschedule": object({
    id,
    plannedOn: day,
    note: short.optional(),
  }),
  "execution.record": object({
    occurrenceId: id,
    performedOn: day,
    note: short.optional(),
  }),
  "execution.update": object({ id, performedOn: day, note: short.optional() }),
  "execution.delete": object(edit),
  "block.save": object({
    ...save,
    input: object({
      title: z.string().max(300),
      description: short.optional(),
      startsAt: timestamp,
      endsAt: timestamp,
      timeZone: z.string().refine(isTimeZone),
      taskIds: ids.optional(),
      occurrenceIds: ids.optional(),
    }),
  }),
  "block.delete": object(edit),
  "sleep.save": object({
    ...save,
    input: object({
      startsAt: timestamp,
      endsAt: timestamp,
      awakeMinutes: z.number().int().min(0).max(10080),
      timeZone: z.string().refine(isTimeZone),
      note: short.optional(),
    }),
  }),
  "sleep.delete": object(edit),
  "note.save": object({
    ...save,
    input: object({
      title,
      content: text,
      tags: tags.optional(),
      targets: z
        .array(
          object({ kind: z.enum(["note", "task", "project", "thought"]), id }),
        )
        .max(1000),
    }),
  }),
  "note.delete": object(edit),
  "tag.create": object({ name: z.string().trim().min(1).max(80) }),
  "tag.rename": object({
    from: z.string().min(1).max(80),
    to: z.string().min(1).max(80).nullable(),
  }),
  "database.save": object({
    ...save,
    input: object({
      title,
      description: short,
      noteId: id.nullable(),
      fields: databaseFieldsSchema,
    }),
  }),
  "database.delete": object({ id, expectedUpdatedAt: revision }),
  "database.record.save": object({
    ...save,
    databaseRevision: revision,
    input: object({
      databaseId: id,
      title,
      content: text,
      values: databaseValuesSchema,
    }),
  }),
  "database.record.delete": object({ id, expectedUpdatedAt: revision }),
} satisfies Record<Command["type"], z.ZodType>;
export const commandNames = Object.keys(schemas);
export function parseCommand(value: unknown): Command {
  const envelope = object({
    type: z.enum(commandNames as [string, ...string[]]),
  })
    .passthrough()
    .parse(value);
  const { type, ...payload } = envelope;
  return {
    type,
    ...schemas[type as keyof typeof schemas].parse(payload),
  } as Command;
}
