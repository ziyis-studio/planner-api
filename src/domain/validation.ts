import {
  databaseFieldsSchema,
  databaseValuesSchema,
  validateDatabaseValues,
} from "./note-databases.js";
import { z } from "zod";
import { PlannerError } from "./model.js";
import type { Workspace } from "./model.js";
import { isDay, isTimeZone } from "./time.js";
import { habitIconNames } from "./habit-icons.js";
import { projectIconNames } from "./project-icons.js";

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const day = z.string().refine(isDay, "Invalid date");
const zone = z.string().refine(isTimeZone, "Invalid time zone");
const entity = z
  .object({ id, createdAt: timestamp, updatedAt: timestamp })
  .strict();
const title = z
  .string()
  .refine((value) => value.trim().length > 0, "Empty title");
const project = entity.extend({
  listPosition: z.number().int().nonnegative().max(2147483647).optional(),
  tags: z.array(z.string().min(1).max(40)).max(30).optional(),
  workStatus: z.enum(["active", "on_hold"]).optional(),
  icon: z.enum(projectIconNames).nullable().optional(),
  title,
  description: z.string(),
  completedAt: timestamp.nullable(),
});
const task = entity.extend({
  listPosition: z.number().int().nonnegative().max(2147483647).optional(),
  tags: z.array(z.string().min(1).max(40)).max(30).optional(),
  workStatus: z.enum(["active", "on_hold"]).optional(),
  projectPosition: z.number().int().nonnegative().max(2147483647).optional(),
  deadline: day.nullable().default(null),
  startedAt: timestamp.nullable().default(null),
  title,
  description: z.string(),
  projectId: id.nullable(),
  completedAt: timestamp.nullable(),
});
const condition = entity.extend({
  taskId: id,
  description: title,
  isMet: z.boolean(),
  position: z.number().int().nonnegative(),
});
const thought = entity.extend({
  title: z.string(),
  content: title,
  emotion: z.string().max(40).nullable().optional(),
});
const habit = entity.extend({
  icon: z.enum(habitIconNames).nullable().optional(),
  title,
  description: z.string(),
  timeZone: zone,
  startsOn: day,
  endsOn: day.nullable(),
  isoWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
});
const occurrence = entity.extend({
  habitId: id,
  scheduledOn: day,
  plannedOn: day,
  timeZone: zone,
  note: z.string(),
});
const execution = entity.extend({
  habitId: id,
  occurrenceId: id,
  performedOn: day,
  note: z.string(),
});
const block = entity.extend({
  recordedType: z.enum(["focus", "short", "long"]).nullable().optional(),
  sourceSessionId: id.nullable().optional(),
  title: z.string(),
  description: z.string(),
  startsAt: timestamp,
  endsAt: timestamp,
  timeZone: zone,
});
const schema = z
  .object({
    schemaVersion: z.literal(1),
    tagCatalog: z
      .array(entity.extend({ name: z.string().min(1).max(40) }))
      .default([]),
    projects: z.array(project),
    tasks: z.array(task),
    conditions: z.array(condition),
    thoughts: z.array(thought),
    noteDatabases: z
      .array(
        entity.extend({
          title,
          description: z.string(),
          noteId: id.nullable(),
          fields: databaseFieldsSchema,
        }),
      )
      .default([]),
    databaseRecords: z
      .array(
        entity.extend({
          databaseId: id,
          title,
          content: z.string(),
          values: databaseValuesSchema,
        }),
      )
      .default([]),
    notes: z
      .array(
        entity.extend({
          title: z.string().trim().min(1),
          content: z.string(),
          tags: z.array(z.string().min(1).max(40)).max(30).optional(),
        }),
      )
      .default([]),
    sleepRecords: z
      .array(
        entity.extend({
          startsAt: timestamp,
          endsAt: timestamp,
          awakeMinutes: z.number().int().nonnegative(),
          timeZone: zone,
          note: z.string(),
        }),
      )
      .default([]),
    noteLinks: z
      .array(
        entity.extend({
          noteId: id,
          targetNoteId: id.nullable(),
          taskId: id.nullable(),
          projectId: id.nullable(),
          thoughtId: id.nullable(),
        }),
      )
      .default([]),
    habits: z.array(habit),
    occurrences: z.array(occurrence),
    executions: z.array(execution),
    timeBlocks: z.array(block),
    thoughtTaskLinks: z.array(z.object({ thoughtId: id, taskId: id }).strict()),
    thoughtProjectLinks: z.array(
      z.object({ thoughtId: id, projectId: id }).strict(),
    ),
    blockTaskLinks: z.array(z.object({ timeBlockId: id, taskId: id }).strict()),
    blockOccurrenceLinks: z.array(
      z.object({ timeBlockId: id, occurrenceId: id }).strict(),
    ),
  })
  .strict();

export function parseWorkspace(value: unknown): Workspace {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new PlannerError(
      "invalid",
      "This workspace or backup has an unsupported or invalid format. No data was changed.",
    );
  const state: Workspace = parsed.data;
  const assert = (ok: boolean, message: string) => {
    if (!ok) throw new PlannerError("invalid", message);
  };
  const unique = (values: string[], message: string) =>
    assert(new Set(values).size === values.length, message);
  const ids = <T extends { id: string }>(items: T[]): Set<string> => {
    unique(
      items.map((item) => item.id),
      "Duplicate record identifiers are not allowed.",
    );
    return new Set(items.map((item) => item.id));
  };
  const projects = ids(state.projects),
    tasks = ids(state.tasks),
    thoughts = ids(state.thoughts),
    habits = ids(state.habits),
    occurrences = ids(state.occurrences),
    blocks = ids(state.timeBlocks);
  ids(state.conditions);
  const notes = ids(state.notes);
  const databases = ids(state.noteDatabases);
  ids(state.databaseRecords);
  for (const db of state.noteDatabases)
    assert(
      !db.noteId || notes.has(db.noteId),
      "A database refers to a missing note.",
    );
  for (const record of state.databaseRecords) {
    assert(
      databases.has(record.databaseId),
      "A record refers to a missing database.",
    );
    validateDatabaseValues(
      state.noteDatabases.find((db) => db.id === record.databaseId)!.fields,
      record.values,
    );
  }
  ids(state.noteLinks);
  for (const l of state.noteLinks) {
    assert(notes.has(l.noteId), "A note link refers to a missing note.");
    assert(
      [l.targetNoteId, l.taskId, l.projectId, l.thoughtId].filter(Boolean)
        .length === 1,
      "A note link must have one target.",
    );
    assert(
      !l.targetNoteId ||
        (notes.has(l.targetNoteId) && l.noteId < l.targetNoteId),
      "Invalid note-to-note link.",
    );
    assert(
      !l.taskId || tasks.has(l.taskId),
      "A note link refers to a missing task.",
    );
    assert(
      !l.projectId || projects.has(l.projectId),
      "A note link refers to a missing project.",
    );
    assert(
      !l.thoughtId || thoughts.has(l.thoughtId),
      "A note link refers to a missing thought.",
    );
  }
  unique(
    state.noteLinks.map(
      (l) =>
        `${l.noteId}:${l.targetNoteId}:${l.taskId}:${l.projectId}:${l.thoughtId}`,
    ),
    "Duplicate note links are not allowed.",
  );
  ids(state.executions);
  ids(state.sleepRecords);
  const sleeps = [...state.sleepRecords].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
  for (let index = 0; index < sleeps.length; index++) {
    const record = sleeps[index];
    const elapsed =
      (Date.parse(record.endsAt) - Date.parse(record.startsAt)) / 60_000;
    assert(
      elapsed > 0 && record.awakeMinutes < elapsed,
      "A sleep record has invalid duration or awake minutes.",
    );
    assert(
      index === 0 ||
        Date.parse(sleeps[index - 1].endsAt) <= Date.parse(record.startsAt),
      "Sleep records cannot overlap.",
    );
  }
  for (const item of state.tasks)
    assert(
      item.projectId === null || projects.has(item.projectId),
      "A task refers to a missing project.",
    );
  for (const item of state.conditions)
    assert(
      tasks.has(item.taskId),
      "A completion condition refers to a missing task.",
    );
  for (const item of state.habits) {
    unique(
      item.isoWeekdays.map(String),
      "Habit execution days must be unique.",
    );
    assert(
      !item.endsOn || item.endsOn >= item.startsOn,
      "A habit ends before its start date.",
    );
  }
  for (const item of state.occurrences)
    assert(
      habits.has(item.habitId),
      "An occurrence refers to a missing habit.",
    );
  unique(
    state.occurrences.map((item) => `${item.habitId}:${item.scheduledOn}`),
    "Duplicate habit occurrences are not allowed.",
  );
  for (const item of state.executions)
    assert(
      occurrences.has(item.occurrenceId) &&
        state.occurrences.some(
          (occ) => occ.id === item.occurrenceId && occ.habitId === item.habitId,
        ),
      "An execution is assigned to the wrong habit occurrence.",
    );
  unique(
    state.executions.map((item) => item.occurrenceId),
    "An occurrence can only have one execution.",
  );
  for (const item of state.timeBlocks)
    assert(
      Date.parse(item.endsAt) > Date.parse(item.startsAt),
      "A time arrangement must end after it starts.",
    );
  for (const item of state.thoughtTaskLinks)
    assert(
      thoughts.has(item.thoughtId) && tasks.has(item.taskId),
      "A thought/task association refers to a missing item.",
    );
  for (const item of state.thoughtProjectLinks)
    assert(
      thoughts.has(item.thoughtId) && projects.has(item.projectId),
      "A thought/project association refers to a missing item.",
    );
  for (const item of state.blockTaskLinks)
    assert(
      blocks.has(item.timeBlockId) && tasks.has(item.taskId),
      "A time/task association refers to a missing item.",
    );
  for (const item of state.blockOccurrenceLinks)
    assert(
      blocks.has(item.timeBlockId) && occurrences.has(item.occurrenceId),
      "A time/habit association refers to a missing item.",
    );
  unique(
    state.thoughtTaskLinks.map((item) => `${item.thoughtId}:${item.taskId}`),
    "Duplicate thought associations are not allowed.",
  );
  unique(
    state.thoughtProjectLinks.map(
      (item) => `${item.thoughtId}:${item.projectId}`,
    ),
    "Duplicate thought associations are not allowed.",
  );
  unique(
    state.blockTaskLinks.map((item) => `${item.timeBlockId}:${item.taskId}`),
    "Duplicate time associations are not allowed.",
  );
  unique(
    state.blockOccurrenceLinks.map(
      (item) => `${item.timeBlockId}:${item.occurrenceId}`,
    ),
    "Duplicate time associations are not allowed.",
  );
  const unmet = new Set(
    state.conditions.filter((item) => !item.isMet).map((item) => item.taskId),
  );
  assert(
    !state.tasks.some((item) => item.completedAt && unmet.has(item.id)),
    "A completed task has an unmet condition.",
  );
  const incompleteProjects = new Set(
    state.tasks
      .filter((item) => !item.completedAt && item.projectId)
      .map((item) => item.projectId),
  );
  assert(
    !state.projects.some(
      (item) => item.completedAt && incompleteProjects.has(item.id),
    ),
    "A completed project has an incomplete task.",
  );
  return state;
}
