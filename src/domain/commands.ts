import { recurrenceDeletion } from "./recurrence-deletion.js";
import {
  databaseFieldsSchema,
  databaseValuesSchema,
  validateDatabaseValues,
} from "./note-databases.js";
import type {
  DatabaseField,
  DatabaseValue,
  NoteDatabase,
  DatabaseRecord,
} from "./note-databases.js";
import { normalizeTags, validWorkStatus } from "./tags.js";
import {
  canCompleteProject,
  canCompleteTask,
  PlannerError,
  requireItem,
  systemClock,
} from "./model.js";
import type {
  Clock,
  Entity,
  Habit,
  TimeBlock,
  Workspace,
  NoteTarget,
} from "./model.js";
import { addDays, isDay, isTimeZone, isoWeekday } from "./time.js";
import { habitIconNames } from "./habit-icons.js";
import type { HabitIconName } from "./habit-icons.js";
import { projectIconNames } from "./project-icons.js";
import type { ProjectIconName } from "./project-icons.js";
import { mealFieldsSchema } from "./meals.js";
import type { MealInput } from "./meals.js";
import { projectTasks } from "./order.js";
import {
  attachRecurrence,
  materializeRecurringTasks,
} from "./recurring-tasks.js";
import { reconcileHabitStarts } from "./habit-occurrences.js";

export type OrderRevision = Pick<Entity, "id" | "updatedAt">;

export interface TaskInput {
  recurrence?: import("./task-recurrence.js").RecurrenceRule | null;
  initialStage?: "todo" | "progress" | "hold" | "done";
  tags?: string[];
  workStatus?: "active" | "on_hold";
  title: string;
  deadline?: string | null;
  description?: string;
  projectId?: string | null;
  conditions?: string[];
  sourceThoughtIds?: string[];
}
export interface ProjectInput {
  initialStage?: "progress" | "hold" | "done";
  tags?: string[];
  workStatus?: "active" | "on_hold";
  icon?: ProjectIconName | null;
  title: string;
  description?: string;
}
export interface ThoughtInput {
  emotion?: string | null;
  title?: string;
  content: string;
  recordedAt?: string;
}
export interface HabitInput {
  icon?: HabitIconName | null;
  title: string;
  description?: string;
  timeZone: string;
  startsOn: string;
  endsOn?: string | null;
  isoWeekdays: number[];
}
export interface BlockInput {
  title: string;
  description?: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  taskIds?: string[];
  occurrenceIds?: string[];
}
export interface SleepInput {
  startsAt: string;
  endsAt: string;
  awakeMinutes: number;
  timeZone: string;
  note?: string;
}
export type Command =
  | { type: "tasks.materialize"; from: string; to: string }
  | {
      type: "task.recurrence.stop" | "task.recurrence.delete";
      id: string;
      expectedUpdatedAt: string;
    }
  | {
      type: "meal.save";
      id?: string;
      input: MealInput;
      expectedUpdatedAt?: string;
    }
  | { type: "meal.delete"; id: string; expectedUpdatedAt: string }
  | {
      type: "task.move";
      id: string;
      stage: "todo" | "progress" | "hold" | "done";
      beforeId?: string | null;
      items?: OrderRevision[];
      expectedUpdatedAt: string;
    }
  | {
      type: "project.move";
      id: string;
      stage: "progress" | "hold" | "done";
      beforeId?: string | null;
      items?: OrderRevision[];
      expectedUpdatedAt: string;
    }
  | { type: "task.reorder" | "project.reorder"; items: OrderRevision[] }
  | {
      type: "database.save";
      id?: string;
      expectedUpdatedAt?: string;
      input: {
        title: string;
        description: string;
        noteId: string | null;
        fields: DatabaseField[];
      };
    }
  | { type: "database.delete"; id: string; expectedUpdatedAt: string }
  | {
      type: "database.record.save";
      id?: string;
      expectedUpdatedAt?: string;
      databaseRevision: string;
      input: {
        databaseId: string;
        title: string;
        content: string;
        values: Record<string, DatabaseValue>;
      };
    }
  | { type: "database.record.delete"; id: string; expectedUpdatedAt: string }
  | { type: "tag.create"; name: string }
  | { type: "tag.rename"; from: string; to: string | null }
  | {
      type: "sleep.save";
      id?: string;
      input: SleepInput;
      expectedUpdatedAt?: string;
    }
  | { type: "sleep.delete"; id: string; expectedUpdatedAt?: string }
  | {
      type: "note.save";
      id?: string;
      expectedUpdatedAt?: string;
      input: {
        title: string;
        content: string;
        targets: NoteTarget[];
        tags?: string[];
      };
    }
  | { type: "note.delete"; id: string; expectedUpdatedAt?: string }
  | { type: "task.create"; input: TaskInput }
  | { type: "project.reorderTasks"; projectId: string; items: OrderRevision[] }
  | { type: "task.reorderConditions"; taskId: string; items: OrderRevision[] }
  | {
      type: "task.update";
      id: string;
      patch: Partial<
        Pick<
          TaskInput,
          | "title"
          | "description"
          | "projectId"
          | "deadline"
          | "tags"
          | "workStatus"
          | "recurrence"
        >
      >;
      expectedUpdatedAt?: string;
    }
  | {
      type: "task.complete" | "task.reopen" | "task.continue";
      id: string;
      expectedUpdatedAt?: string;
    }
  | { type: "task.delete"; id: string }
  | { type: "condition.add"; taskId: string; description: string }
  | {
      type: "condition.update";
      id: string;
      patch: { description?: string; isMet?: boolean };
    }
  | { type: "condition.delete"; id: string }
  | { type: "project.create"; input: ProjectInput }
  | {
      type: "project.update";
      id: string;
      input: ProjectInput;
      expectedUpdatedAt?: string;
    }
  | {
      type: "project.complete" | "project.reopen" | "project.delete";
      id: string;
    }
  | { type: "thought.create"; input: ThoughtInput }
  | {
      type: "thought.update";
      id: string;
      input: Omit<ThoughtInput, "recordedAt">;
      expectedUpdatedAt?: string;
    }
  | { type: "thought.delete"; id: string }
  | {
      type: "thought.convert";
      thoughtIds: string[];
      kind: "task" | "project";
      input: ProjectInput;
    }
  | {
      type: "thought.link" | "thought.unlink";
      kind: "task" | "project";
      targetId: string;
      thoughtIds: string[];
    }
  | { type: "habit.create"; input: HabitInput }
  | {
      type: "habit.update";
      id: string;
      input: HabitInput;
      expectedUpdatedAt?: string;
    }
  | { type: "habit.delete"; id: string; expectedUpdatedAt?: string }
  | { type: "occurrences.materialize"; from: string; to: string }
  | {
      type: "occurrence.reschedule";
      id: string;
      plannedOn: string;
      note?: string;
    }
  | {
      type: "execution.record";
      occurrenceId: string;
      performedOn: string;
      note?: string;
    }
  | { type: "execution.update"; id: string; performedOn: string; note?: string }
  | { type: "execution.delete"; id: string; expectedUpdatedAt?: string }
  | {
      type: "block.save";
      id?: string;
      input: BlockInput;
      expectedUpdatedAt?: string;
    }
  | { type: "block.delete"; id: string; expectedUpdatedAt?: string };

export interface CommandResult {
  snapshot: Workspace;
  id?: string;
}
const distinct = (values: string[] = []) => [...new Set(values)];
function validProjectIcon(value: ProjectIconName | null) {
  if (value !== null && !projectIconNames.includes(value))
    throw new PlannerError("invalid", "Choose a project icon.");
  return value;
}
export function requiredText(value: string, label = "Title"): string {
  const result = value.trim();
  if (!result) throw new PlannerError("invalid", `${label} cannot be empty.`);
  return result;
}
function validTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()))
    throw new PlannerError("invalid", "Choose a valid date and time.");
  return parsed.toISOString();
}
function validDay(value: string): string {
  if (!isDay(value)) throw new PlannerError("invalid", "Choose a valid date.");
  return value;
}
function habitFields(input: HabitInput): Omit<Habit, keyof Entity> {
  if (input.icon != null && !habitIconNames.includes(input.icon))
    throw new PlannerError("invalid", "Choose a habit icon.");
  const days = [...new Set(input.isoWeekdays)].sort((a, b) => a - b);
  if (
    !days.length ||
    days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
  )
    throw new PlannerError("invalid", "Choose at least one execution day.");
  if (!isTimeZone(input.timeZone))
    throw new PlannerError("invalid", "Choose a valid time zone.");
  validDay(input.startsOn);
  if (input.endsOn && validDay(input.endsOn) < input.startsOn)
    throw new PlannerError(
      "invalid",
      "The end date cannot be before the start date.",
    );
  return {
    icon: input.icon ?? null,
    title: requiredText(input.title),
    description: input.description ?? "",
    timeZone: input.timeZone,
    startsOn: input.startsOn,
    endsOn: input.endsOn || null,
    isoWeekdays: days,
  };
}

/** A command is one transaction: callers receive a new snapshot or the original remains untouched. */
export function applyCommand(
  original: Workspace,
  command: Command,
  clock: Clock = systemClock,
): CommandResult {
  const state = structuredClone(original);
  const now = validTimestamp(clock.now());
  const entity = (): Entity => ({
    id: clock.id(),
    createdAt: now,
    updatedAt: now,
  });
  const touch = <T extends Entity>(item: T): T => {
    item.updatedAt = now;
    return item;
  };
  const checkRevision = (item: Entity, expected?: string) => {
    if (expected && item.updatedAt !== expected)
      throw new PlannerError(
        "conflict",
        "This item changed elsewhere. Reload it before saving.",
      );
  };
  const reopenParent = (projectId: string | null) => {
    if (!projectId) return;
    const project = requireItem(state.projects, projectId, "Project");
    if (project.completedAt) {
      project.completedAt = null;
      touch(project);
    }
  };
  const reopenTask = (taskId: string) => {
    const task = requireItem(state.tasks, taskId, "Task");
    if (task.completedAt) {
      task.completedAt = null;
      touch(task);
    }
    reopenParent(task.projectId);
  };
  const linkSources = (
    kind: "task" | "project",
    targetId: string,
    thoughtIds: string[],
  ) => {
    for (const thoughtId of distinct(thoughtIds)) {
      requireItem(state.thoughts, thoughtId, "Thought");
      if (kind === "task") {
        requireItem(state.tasks, targetId, "Task");
        if (
          !state.thoughtTaskLinks.some(
            (link) => link.taskId === targetId && link.thoughtId === thoughtId,
          )
        )
          state.thoughtTaskLinks.push({ thoughtId, taskId: targetId });
      } else {
        requireItem(state.projects, targetId, "Project");
        if (
          !state.thoughtProjectLinks.some(
            (link) =>
              link.projectId === targetId && link.thoughtId === thoughtId,
          )
        )
          state.thoughtProjectLinks.push({ thoughtId, projectId: targetId });
      }
    }
  };
  const validateOrder = <T extends Entity>(
    members: T[],
    items: OrderRevision[],
  ): T[] => {
    if (
      items.length !== members.length ||
      new Set(items.map((item) => item.id)).size !== members.length
    )
      throw new PlannerError(
        "conflict",
        "This list changed elsewhere. Refresh before reordering.",
      );
    return items.map((item) => {
      const member = members.find((candidate) => candidate.id === item.id);
      if (!member || !item.updatedAt)
        throw new PlannerError(
          "conflict",
          "This list changed elsewhere. Refresh before reordering.",
        );
      checkRevision(member, item.updatedAt);
      return member;
    });
  };
  const nextProjectPosition = (projectId: string | null) =>
    projectId
      ? Math.max(
          -1,
          ...projectTasks(state, projectId).map(
            (task) => task.projectPosition ?? 0,
          ),
        ) + 1
      : 0;
  const place = <T extends Entity & { listPosition?: number }>(
    members: T[],
    command: { id: string; beforeId?: string | null; items?: OrderRevision[] },
  ) => {
    if (command.beforeId === undefined) return;
    if (!command.items)
      throw new PlannerError("invalid", "Order revisions required.");
    const ordered = validateOrder(members, command.items);
    if (command.beforeId === command.id) return;
    const source = requireItem(ordered, command.id, "Item"),
      rest = ordered.filter((x) => x.id !== command.id);
    const at =
      command.beforeId === null
        ? rest.length
        : rest.findIndex((x) => x.id === command.beforeId);
    if (at < 0)
      throw new PlannerError(
        "conflict",
        "The target changed. Refresh before reordering.",
      );
    rest.splice(at, 0, source);
    rest.forEach((item, index) => {
      if (item.listPosition !== index) {
        item.listPosition = index;
        touch(item);
      }
    });
  };
  let resultId: string | undefined;
  switch (command.type) {
    case "tasks.materialize": {
      materializeRecurringTasks(state, command.from, command.to, entity);
      break;
    }
    case "task.recurrence.delete": {
      const series = requireItem(
        state.taskRecurrences,
        command.id,
        "Repeat schedule",
      );
      checkRevision(series, command.expectedUpdatedAt);
      const { taskIds, blockIds } = recurrenceDeletion(state, series.id);
      state.conditions = state.conditions.filter((c) => !taskIds.has(c.taskId));
      state.thoughtTaskLinks = state.thoughtTaskLinks.filter(
        (l) => !taskIds.has(l.taskId),
      );
      state.blockTaskLinks = state.blockTaskLinks.filter(
        (l) => !taskIds.has(l.taskId),
      );
      state.timeBlocks = state.timeBlocks.filter((b) => !blockIds.has(b.id));
      state.tasks = state.tasks.filter((t) => !taskIds.has(t.id));
      state.taskRecurrences = state.taskRecurrences.filter(
        (r) => r.id !== series.id,
      );
      break;
    }
    case "task.recurrence.stop": {
      const series = requireItem(
        state.taskRecurrences,
        command.id,
        "Repeat schedule",
      );
      checkRevision(series, command.expectedUpdatedAt);
      series.active = false;
      touch(series);
      break;
    }
    case "task.move": {
      const task = requireItem(state.tasks, command.id, "Task");
      checkRevision(task, command.expectedUpdatedAt);
      if (command.stage === "done" && !canCompleteTask(state, task.id))
        throw new PlannerError(
          "conditions_unmet",
          "Meet every completion condition before confirming this task.",
        );
      task.completedAt = command.stage === "done" ? now : null;
      task.workStatus = command.stage === "hold" ? "on_hold" : "active";
      task.startedAt =
        command.stage === "todo"
          ? null
          : command.stage === "progress"
            ? task.startedAt || now
            : task.startedAt;
      if (!task.completedAt) reopenParent(task.projectId);
      place(state.tasks, command);
      touch(task);
      break;
    }
    case "project.move": {
      const project = requireItem(state.projects, command.id, "Project");
      checkRevision(project, command.expectedUpdatedAt);
      if (command.stage === "done" && !canCompleteProject(state, project.id))
        throw new PlannerError(
          "tasks_incomplete",
          "Complete every task before confirming this project.",
        );
      project.completedAt = command.stage === "done" ? now : null;
      project.workStatus = command.stage === "hold" ? "on_hold" : "active";
      place(state.projects, command);
      touch(project);
      break;
    }
    case "task.reorder":
    case "project.reorder": {
      const members =
        command.type === "task.reorder" ? state.tasks : state.projects;
      validateOrder(members, command.items).forEach((item, position) => {
        if (item.listPosition !== position) {
          item.listPosition = position;
          touch(item);
        }
      });
      break;
    }
    case "database.save": {
      const fields = databaseFieldsSchema.safeParse(command.input.fields);
      if (!fields.success)
        throw new PlannerError("invalid", fields.error.issues[0].message);
      const db: NoteDatabase = command.id
        ? requireItem(state.noteDatabases, command.id, "Database")
        : { ...entity(), title: "", description: "", fields: [], noteId: null };
      if (command.id) checkRevision(db, command.expectedUpdatedAt);
      if (command.input.noteId)
        requireItem(state.notes, command.input.noteId, "Note");
      for (const field of fields.data) {
        const old = db.fields.find((f) => f.id === field.id);
        if (old && old.type !== field.type)
          throw new PlannerError(
            "invalid",
            "Create a new property to use a different type.",
          );
      }
      for (const record of state.databaseRecords.filter(
        (r) => r.databaseId === db.id,
      )) {
        const values = Object.fromEntries(
          Object.entries(record.values).filter(([id]) =>
            fields.data.some((f) => f.id === id),
          ),
        );
        validateDatabaseValues(fields.data, values);
        if (JSON.stringify(values) !== JSON.stringify(record.values)) {
          record.values = values;
          touch(record);
        }
      }
      Object.assign(db, {
        ...command.input,
        title: requiredText(command.input.title),
        fields: fields.data,
      });
      touch(db);
      if (!command.id) state.noteDatabases.push(db);
      resultId = db.id;
      break;
    }
    case "database.delete": {
      const db = requireItem(state.noteDatabases, command.id, "Database");
      checkRevision(db, command.expectedUpdatedAt);
      state.databaseRecords = state.databaseRecords.filter(
        (r) => r.databaseId !== db.id,
      );
      state.noteDatabases = state.noteDatabases.filter((d) => d.id !== db.id);
      break;
    }
    case "database.record.save": {
      const db = requireItem(
        state.noteDatabases,
        command.input.databaseId,
        "Database",
      );
      checkRevision(db, command.databaseRevision);
      const parsed = databaseValuesSchema.safeParse(command.input.values);
      if (!parsed.success)
        throw new PlannerError("invalid", "Invalid property values.");
      validateDatabaseValues(db.fields, parsed.data);
      const record: DatabaseRecord = command.id
        ? requireItem(state.databaseRecords, command.id, "Record")
        : {
            ...entity(),
            databaseId: db.id,
            title: "",
            content: "",
            values: {},
          };
      if (record.databaseId !== db.id)
        throw new PlannerError(
          "invalid",
          "A record cannot be moved between databases.",
        );
      if (command.id) checkRevision(record, command.expectedUpdatedAt);
      Object.assign(record, {
        ...command.input,
        title: requiredText(command.input.title),
        values: parsed.data,
      });
      touch(record);
      if (!command.id) state.databaseRecords.push(record);
      resultId = record.id;
      break;
    }
    case "database.record.delete": {
      const record = requireItem(state.databaseRecords, command.id, "Record");
      checkRevision(record, command.expectedUpdatedAt);
      state.databaseRecords = state.databaseRecords.filter(
        (r) => r.id !== record.id,
      );
      break;
    }
    case "meal.save": {
      const parsed = mealFieldsSchema.safeParse(command.input);
      if (!parsed.success)
        throw new PlannerError("invalid", parsed.error.issues[0].message);
      const fields = {
        ...parsed.data,
        ateAt: validTimestamp(parsed.data.ateAt),
      };
      if (Date.parse(fields.ateAt) > Date.parse(now) + 60000)
        throw new PlannerError(
          "invalid",
          "Meals must be recorded in the past or present.",
        );
      if (command.id) {
        const meal = requireItem(state.meals, command.id, "Meal");
        if (!command.expectedUpdatedAt)
          throw new PlannerError("conflict", "Reload this meal before saving.");
        checkRevision(meal, command.expectedUpdatedAt);
        Object.assign(meal, fields);
        touch(meal);
        resultId = meal.id;
      } else {
        const meal = { ...entity(), ...fields };
        state.meals.push(meal);
        resultId = meal.id;
      }
      break;
    }
    case "meal.delete": {
      const meal = requireItem(state.meals, command.id, "Meal");
      checkRevision(meal, command.expectedUpdatedAt);
      state.meals = state.meals.filter((m) => m.id !== meal.id);
      break;
    }
    case "sleep.save": {
      const input = command.input;
      const startsAt = validTimestamp(input.startsAt);
      const endsAt = validTimestamp(input.endsAt);
      const elapsed = (Date.parse(endsAt) - Date.parse(startsAt)) / 60_000;
      if (!isTimeZone(input.timeZone))
        throw new PlannerError("invalid", "Choose a valid time zone.");
      if (elapsed <= 0)
        throw new PlannerError(
          "invalid",
          "Wake-up must be after you fell asleep. Check both dates.",
        );
      if (
        !Number.isInteger(input.awakeMinutes) ||
        input.awakeMinutes < 0 ||
        input.awakeMinutes >= elapsed
      )
        throw new PlannerError(
          "invalid",
          "Awake minutes must be less than the recorded time span.",
        );
      if (Date.parse(endsAt) > Date.parse(now) + 60_000)
        throw new PlannerError(
          "invalid",
          "Sleep records must finish in the past.",
        );
      if (
        state.sleepRecords.some(
          (record) =>
            record.id !== command.id &&
            Date.parse(record.startsAt) < Date.parse(endsAt) &&
            Date.parse(record.endsAt) > Date.parse(startsAt),
        )
      )
        throw new PlannerError(
          "invalid",
          "This overlaps another sleep record. Edit that record or choose different times.",
        );
      const fields = {
        startsAt,
        endsAt,
        awakeMinutes: input.awakeMinutes,
        timeZone: input.timeZone,
        note: input.note?.trim() || "",
      };
      if (command.id) {
        const record = requireItem(
          state.sleepRecords,
          command.id,
          "Sleep record",
        );
        checkRevision(record, command.expectedUpdatedAt);
        Object.assign(record, fields);
        touch(record);
        resultId = record.id;
      } else {
        const record = { ...entity(), ...fields };
        state.sleepRecords.push(record);
        resultId = record.id;
      }
      break;
    }
    case "sleep.delete": {
      const record = requireItem(
        state.sleepRecords,
        command.id,
        "Sleep record",
      );
      checkRevision(record, command.expectedUpdatedAt);
      state.sleepRecords = state.sleepRecords.filter(
        (item) => item.id !== record.id,
      );
      break;
    }
    case "project.reorderTasks": {
      requireItem(state.projects, command.projectId, "Project");
      validateOrder(
        projectTasks(state, command.projectId),
        command.items,
      ).forEach((task, position) => {
        if (task.projectPosition !== position) {
          task.projectPosition = position;
          touch(task);
        }
      });
      break;
    }
    case "task.reorderConditions": {
      requireItem(state.tasks, command.taskId, "Task");
      validateOrder(
        state.conditions.filter((item) => item.taskId === command.taskId),
        command.items,
      ).forEach((condition, position) => {
        if (condition.position !== position) {
          condition.position = position;
          touch(condition);
        }
      });
      break;
    }
    case "tag.create": {
      const name = normalizeTags([command.name])[0];
      if (!name) throw new PlannerError("invalid", "Enter a tag name.");
      if (!state.tagCatalog.some((tag) => tag.name === name))
        state.tagCatalog.push({ ...entity(), name });
      break;
    }
    case "tag.rename": {
      const replacement =
        command.to === null ? [] : normalizeTags([command.to]);
      if (command.to !== null && !replacement.length)
        throw new PlannerError("invalid", "Enter a tag name.");
      const catalog = state.tagCatalog.find((tag) => tag.name === command.from);
      if (catalog) {
        if (
          !replacement.length ||
          state.tagCatalog.some(
            (tag) => tag !== catalog && tag.name === replacement[0],
          )
        )
          state.tagCatalog = state.tagCatalog.filter((tag) => tag !== catalog);
        else {
          catalog.name = replacement[0];
          touch(catalog);
        }
      }
      for (const item of [
        ...state.tasks,
        ...state.projects,
        ...state.notes,
        ...state.taskRecurrences,
      ]) {
        if (item.tags?.includes(command.from)) {
          item.tags = normalizeTags(
            item.tags.flatMap((tag) =>
              tag === command.from ? replacement : [tag],
            ),
          );
          touch(item);
        }
      }
      break;
    }
    case "task.create": {
      const input = command.input;
      const status = validWorkStatus(input.workStatus);
      const stage =
        input.initialStage ?? (status === "on_hold" ? "hold" : "todo");
      if (!["todo", "progress", "hold", "done"].includes(stage))
        throw new PlannerError("invalid", "Choose a valid task status.");
      if (stage === "done" && input.conditions?.length)
        throw new PlannerError(
          "conditions_unmet",
          "Meet every completion condition before confirming this task. Choose another status to create it first.",
        );
      if (input.projectId)
        requireItem(state.projects, input.projectId, "Project");
      if (input.deadline != null && !isDay(input.deadline))
        throw new PlannerError("invalid", "Choose a valid deadline.");
      const task = {
        ...entity(),
        tags: normalizeTags(input.tags || []),
        workStatus:
          stage === "hold" ? ("on_hold" as const) : ("active" as const),
        deadline: input.deadline ?? null,
        startedAt: stage === "progress" || stage === "done" ? now : null,
        title: requiredText(input.title),
        description: input.description ?? "",
        projectId: input.projectId || null,
        projectPosition: nextProjectPosition(input.projectId || null),
        listPosition:
          Math.max(-1, ...state.tasks.map((t) => t.listPosition ?? 0)) + 1,
        completedAt: stage === "done" ? now : null,
      };
      state.tasks.push(task);
      (input.conditions ?? []).forEach((description, position) =>
        state.conditions.push({
          ...entity(),
          taskId: task.id,
          description: requiredText(description, "Condition"),
          isMet: false,
          position,
        }),
      );
      if (input.recurrence)
        attachRecurrence(state, task, input.recurrence, entity);
      linkSources("task", task.id, input.sourceThoughtIds ?? []);
      if (!task.completedAt) reopenParent(task.projectId);
      resultId = task.id;
      break;
    }
    case "task.update": {
      const task = requireItem(state.tasks, command.id, "Task");
      checkRevision(task, command.expectedUpdatedAt);
      if (command.patch.tags !== undefined)
        task.tags = normalizeTags(command.patch.tags);
      if (command.patch.workStatus !== undefined)
        task.workStatus = validWorkStatus(command.patch.workStatus);
      if (command.patch.title !== undefined)
        task.title = requiredText(command.patch.title);
      if (command.patch.description !== undefined)
        task.description = command.patch.description;
      if (command.patch.deadline !== undefined) {
        if (command.patch.deadline !== null && !isDay(command.patch.deadline))
          throw new PlannerError("invalid", "Choose a valid deadline.");
        task.deadline = command.patch.deadline;
      }
      if (command.patch.projectId !== undefined) {
        if (command.patch.projectId)
          requireItem(state.projects, command.patch.projectId, "Project");
        const nextProject = command.patch.projectId || null;
        if (task.projectId !== nextProject)
          task.projectPosition = nextProjectPosition(nextProject);
        task.projectId = nextProject;
      }
      if (command.patch.recurrence)
        attachRecurrence(state, task, command.patch.recurrence, entity);
      touch(task);
      if (!task.completedAt) reopenParent(task.projectId);
      resultId = task.id;
      break;
    }
    case "task.complete": {
      const task = requireItem(state.tasks, command.id, "Task");
      checkRevision(task, command.expectedUpdatedAt);
      if (!canCompleteTask(state, task.id))
        throw new PlannerError(
          "conditions_unmet",
          "Meet every completion condition before confirming this task.",
        );
      task.completedAt = now;
      touch(task);
      resultId = task.id;
      break;
    }
    case "task.reopen": {
      const task = requireItem(state.tasks, command.id, "Task");
      checkRevision(task, command.expectedUpdatedAt);
      reopenTask(command.id);
      task.startedAt = null;
      touch(task);
      resultId = command.id;
      break;
    }
    case "task.continue": {
      const task = requireItem(state.tasks, command.id, "Task");
      checkRevision(task, command.expectedUpdatedAt);
      task.startedAt = task.startedAt || now;
      task.completedAt = null;
      touch(task);
      reopenParent(task.projectId);
      resultId = task.id;
      break;
    }
    case "task.delete": {
      const task = requireItem(state.tasks, command.id, "Task");
      const series = state.taskRecurrences.find(
        (r) => r.id === task.recurrenceId,
      );
      if (
        series &&
        task.scheduledOn &&
        !series.skippedOn.includes(task.scheduledOn)
      ) {
        series.skippedOn.push(task.scheduledOn);
        touch(series);
      }
      state.tasks = state.tasks.filter((item) => item.id !== command.id);
      state.conditions = state.conditions.filter(
        (item) => item.taskId !== command.id,
      );
      state.thoughtTaskLinks = state.thoughtTaskLinks.filter(
        (item) => item.taskId !== command.id,
      );
      state.blockTaskLinks = state.blockTaskLinks.filter(
        (item) => item.taskId !== command.id,
      );
      break;
    }
    case "condition.add": {
      requireItem(state.tasks, command.taskId, "Task");
      const position =
        Math.max(
          -1,
          ...state.conditions
            .filter((item) => item.taskId === command.taskId)
            .map((item) => item.position),
        ) + 1;
      const condition = {
        ...entity(),
        taskId: command.taskId,
        description: requiredText(command.description, "Condition"),
        isMet: false,
        position,
      };
      state.conditions.push(condition);
      reopenTask(command.taskId);
      resultId = condition.id;
      break;
    }
    case "condition.update": {
      const condition = requireItem(state.conditions, command.id, "Condition");
      if (command.patch.description !== undefined)
        condition.description = requiredText(
          command.patch.description,
          "Condition",
        );
      if (command.patch.isMet !== undefined)
        condition.isMet = command.patch.isMet;
      touch(condition);
      if (!condition.isMet) reopenTask(condition.taskId);
      resultId = condition.id;
      break;
    }
    case "condition.delete":
      requireItem(state.conditions, command.id, "Condition");
      state.conditions = state.conditions.filter(
        (item) => item.id !== command.id,
      );
      break;
    case "project.create": {
      const status = validWorkStatus(command.input.workStatus);
      const stage =
        command.input.initialStage ??
        (status === "on_hold" ? "hold" : "progress");
      if (!["progress", "hold", "done"].includes(stage))
        throw new PlannerError("invalid", "Choose a valid project status.");
      const project = {
        ...entity(),
        listPosition:
          Math.max(-1, ...state.projects.map((p) => p.listPosition ?? 0)) + 1,
        tags: normalizeTags(command.input.tags || []),
        workStatus:
          stage === "hold" ? ("on_hold" as const) : ("active" as const),
        ...(command.input.icon !== undefined
          ? { icon: validProjectIcon(command.input.icon) }
          : {}),
        title: requiredText(command.input.title),
        description: command.input.description ?? "",
        completedAt: stage === "done" ? now : null,
      };
      state.projects.push(project);
      resultId = project.id;
      break;
    }
    case "project.update": {
      const project = requireItem(state.projects, command.id, "Project");
      checkRevision(project, command.expectedUpdatedAt);
      if (command.input.tags !== undefined)
        project.tags = normalizeTags(command.input.tags);
      if (command.input.workStatus !== undefined)
        project.workStatus = validWorkStatus(command.input.workStatus);
      project.title = requiredText(command.input.title);
      project.description = command.input.description ?? "";
      if (command.input.icon !== undefined)
        project.icon = validProjectIcon(command.input.icon);
      touch(project);
      resultId = project.id;
      break;
    }
    case "project.complete": {
      const project = requireItem(state.projects, command.id, "Project");
      if (!canCompleteProject(state, project.id))
        throw new PlannerError(
          "tasks_incomplete",
          "Complete every task before confirming this project.",
        );
      project.completedAt = now;
      touch(project);
      resultId = project.id;
      break;
    }
    case "project.reopen": {
      const project = requireItem(state.projects, command.id, "Project");
      project.completedAt = null;
      touch(project);
      resultId = project.id;
      break;
    }
    case "project.delete": {
      for (const series of state.taskRecurrences.filter(
        (r) => r.projectId === command.id,
      )) {
        series.projectId = null;
        touch(series);
      }
      requireItem(state.projects, command.id, "Project");
      for (const task of projectTasks(state, command.id)) {
        const position = nextProjectPosition(null);
        task.projectId = null;
        task.projectPosition = position;
        touch(task);
      }
      state.projects = state.projects.filter((item) => item.id !== command.id);
      state.thoughtProjectLinks = state.thoughtProjectLinks.filter(
        (item) => item.projectId !== command.id,
      );
      break;
    }
    case "thought.create": {
      const thought = {
        ...entity(),
        title: command.input.title?.trim() ?? "",
        content: requiredText(command.input.content, "Thought"),
        emotion: command.input.emotion?.trim() || null,
        createdAt: command.input.recordedAt
          ? validTimestamp(command.input.recordedAt)
          : now,
      };
      state.thoughts.push(thought);
      resultId = thought.id;
      break;
    }
    case "thought.update": {
      const thought = requireItem(state.thoughts, command.id, "Thought");
      checkRevision(thought, command.expectedUpdatedAt);
      thought.title = command.input.title?.trim() ?? "";
      thought.content = requiredText(command.input.content, "Thought");
      if (command.input.emotion !== undefined)
        thought.emotion = command.input.emotion?.trim() || null;
      touch(thought);
      resultId = thought.id;
      break;
    }
    case "thought.delete": {
      requireItem(state.thoughts, command.id, "Thought");
      state.thoughts = state.thoughts.filter((item) => item.id !== command.id);
      state.thoughtTaskLinks = state.thoughtTaskLinks.filter(
        (item) => item.thoughtId !== command.id,
      );
      state.thoughtProjectLinks = state.thoughtProjectLinks.filter(
        (item) => item.thoughtId !== command.id,
      );
      break;
    }
    case "thought.convert": {
      if (!command.thoughtIds.length)
        throw new PlannerError(
          "invalid",
          "Choose at least one source thought.",
        );
      for (const id of command.thoughtIds)
        requireItem(state.thoughts, id, "Thought");
      const created = {
        ...entity(),
        title: requiredText(command.input.title),
        description: command.input.description ?? "",
        completedAt: null,
      };
      if (command.kind === "task")
        state.tasks.push({
          ...created,
          projectId: null,
          deadline: null,
          startedAt: null,
        });
      else
        state.projects.push({
          ...created,
          ...(command.input.icon !== undefined
            ? { icon: validProjectIcon(command.input.icon) }
            : {}),
        });
      linkSources(command.kind, created.id, command.thoughtIds);
      resultId = created.id;
      break;
    }
    case "thought.link":
      linkSources(command.kind, command.targetId, command.thoughtIds);
      break;
    case "thought.unlink": {
      if (command.kind === "task")
        state.thoughtTaskLinks = state.thoughtTaskLinks.filter(
          (item) =>
            item.taskId !== command.targetId ||
            !command.thoughtIds.includes(item.thoughtId),
        );
      else
        state.thoughtProjectLinks = state.thoughtProjectLinks.filter(
          (item) =>
            item.projectId !== command.targetId ||
            !command.thoughtIds.includes(item.thoughtId),
        );
      break;
    }
    case "habit.create": {
      const habit = { ...entity(), ...habitFields(command.input) };
      state.habits.push(habit);
      resultId = habit.id;
      break;
    }
    case "habit.update": {
      const habit = requireItem(state.habits, command.id, "Habit");
      checkRevision(habit, command.expectedUpdatedAt);
      Object.assign(
        habit,
        habitFields({
          ...command.input,
          icon:
            command.input.icon === undefined
              ? (habit.icon ?? null)
              : command.input.icon,
        }),
      );
      reconcileHabitStarts(state, habit.id);
      touch(habit);
      resultId = habit.id;
      break;
    }
    case "habit.delete": {
      checkRevision(
        requireItem(state.habits, command.id, "Habit"),
        command.expectedUpdatedAt,
      );
      const occurrenceIds = new Set(
        state.occurrences
          .filter((item) => item.habitId === command.id)
          .map((item) => item.id),
      );
      state.blockOccurrenceLinks = state.blockOccurrenceLinks.filter(
        (link) => !occurrenceIds.has(link.occurrenceId),
      );
      state.executions = state.executions.filter(
        (item) => item.habitId !== command.id,
      );
      state.occurrences = state.occurrences.filter(
        (item) => item.habitId !== command.id,
      );
      state.habits = state.habits.filter((item) => item.id !== command.id);
      break;
    }
    case "occurrences.materialize": {
      validDay(command.from);
      validDay(command.to);
      const length = Math.round(
        (new Date(`${command.to}T12:00:00Z`).valueOf() -
          new Date(`${command.from}T12:00:00Z`).valueOf()) /
          86_400_000,
      );
      if (length < 0 || length > 366)
        throw new PlannerError(
          "invalid",
          "Choose an occurrence window of at most one year.",
        );
      // Also repair placeholders left by earlier versions. Advance the parent's
      // revision so cloud cleanup cannot race a concurrent start-date edit.
      for (const id of reconcileHabitStarts(state)) {
        const habit = requireItem(state.habits, id, "Habit");
        habit.updatedAt = new Date(
          Math.max(Date.parse(now), Date.parse(habit.updatedAt) + 1),
        ).toISOString();
      }
      const existing = new Set(
        state.occurrences.map((item) => `${item.habitId}:${item.scheduledOn}`),
      );
      for (const habit of state.habits)
        for (let index = 0; index <= length; index++) {
          const day = addDays(command.from, index),
            key = `${habit.id}:${day}`;
          if (
            day < habit.startsOn ||
            (habit.endsOn && day > habit.endsOn) ||
            !habit.isoWeekdays.includes(isoWeekday(day)) ||
            existing.has(key)
          )
            continue;
          state.occurrences.push({
            ...entity(),
            habitId: habit.id,
            scheduledOn: day,
            plannedOn: day,
            timeZone: habit.timeZone,
            note: "",
          });
          existing.add(key);
        }
      break;
    }
    case "occurrence.reschedule": {
      const occurrence = requireItem(
        state.occurrences,
        command.id,
        "Occurrence",
      );
      occurrence.plannedOn = validDay(command.plannedOn);
      if (command.note !== undefined) occurrence.note = command.note;
      touch(occurrence);
      resultId = occurrence.id;
      break;
    }
    case "execution.record": {
      const occurrence = requireItem(
        state.occurrences,
        command.occurrenceId,
        "Occurrence",
      );
      if (state.executions.some((item) => item.occurrenceId === occurrence.id))
        throw new PlannerError(
          "restricted",
          "This occurrence is already recorded. Edit or undo its completion.",
        );
      const execution = {
        ...entity(),
        habitId: occurrence.habitId,
        occurrenceId: occurrence.id,
        performedOn: validDay(command.performedOn),
        note: command.note ?? "",
      };
      state.executions.push(execution);
      resultId = execution.id;
      break;
    }
    case "execution.update": {
      const execution = requireItem(state.executions, command.id, "Execution");
      execution.performedOn = validDay(command.performedOn);
      if (command.note !== undefined) execution.note = command.note;
      touch(execution);
      resultId = execution.id;
      break;
    }
    case "execution.delete":
      checkRevision(
        requireItem(state.executions, command.id, "Execution"),
        command.expectedUpdatedAt,
      );
      state.executions = state.executions.filter(
        (item) => item.id !== command.id,
      );
      break;
    case "block.save": {
      const input = command.input,
        taskIds = distinct(input.taskIds),
        occurrenceIds = distinct(input.occurrenceIds);
      for (const id of taskIds) requireItem(state.tasks, id, "Task");
      for (const id of occurrenceIds)
        requireItem(state.occurrences, id, "Occurrence");
      const startsAt = validTimestamp(input.startsAt),
        endsAt = validTimestamp(input.endsAt);
      if (new Date(endsAt).valueOf() <= new Date(startsAt).valueOf())
        throw new PlannerError("invalid", "End time must be after start time.");
      if (!isTimeZone(input.timeZone))
        throw new PlannerError("invalid", "Choose a valid time zone.");
      const title = input.title.trim();
      if (!title && !taskIds.length && !occurrenceIds.length)
        throw new PlannerError("invalid", "Give this activity a title.");
      let block: TimeBlock;
      if (command.id) {
        block = requireItem(state.timeBlocks, command.id, "Time arrangement");
        checkRevision(block, command.expectedUpdatedAt);
      } else {
        block = {
          ...entity(),
          title: "",
          description: "",
          startsAt,
          endsAt,
          timeZone: input.timeZone,
        };
        state.timeBlocks.push(block);
      }
      Object.assign(block, {
        title,
        description: input.description ?? "",
        startsAt,
        endsAt,
        timeZone: input.timeZone,
      });
      touch(block);
      state.blockTaskLinks = state.blockTaskLinks.filter(
        (item) => item.timeBlockId !== block.id,
      );
      state.blockOccurrenceLinks = state.blockOccurrenceLinks.filter(
        (item) => item.timeBlockId !== block.id,
      );
      for (const taskId of taskIds)
        state.blockTaskLinks.push({ timeBlockId: block.id, taskId });
      for (const occurrenceId of occurrenceIds)
        state.blockOccurrenceLinks.push({
          timeBlockId: block.id,
          occurrenceId,
        });
      resultId = block.id;
      break;
    }
    case "block.delete": {
      checkRevision(
        requireItem(state.timeBlocks, command.id, "Time arrangement"),
        command.expectedUpdatedAt,
      );
      state.timeBlocks = state.timeBlocks.filter(
        (item) => item.id !== command.id,
      );
      state.blockTaskLinks = state.blockTaskLinks.filter(
        (item) => item.timeBlockId !== command.id,
      );
      state.blockOccurrenceLinks = state.blockOccurrenceLinks.filter(
        (item) => item.timeBlockId !== command.id,
      );
      break;
    }
    case "note.save": {
      const note = command.id
        ? requireItem(state.notes, command.id, "Note")
        : { ...entity(), title: "", content: "", tags: [] as string[] };
      if (command.id) checkRevision(note, command.expectedUpdatedAt);
      else state.notes.push(note);
      if (command.input.tags !== undefined)
        note.tags = normalizeTags(command.input.tags);
      note.title = requiredText(command.input.title);
      note.content = command.input.content;
      touch(note);
      const existing = state.noteLinks.filter(
        (l) => l.noteId === note.id || l.targetNoteId === note.id,
      );
      state.noteLinks = state.noteLinks.filter(
        (l) => l.noteId !== note.id && l.targetNoteId !== note.id,
      );
      const seen = new Set<string>();
      for (const target of command.input.targets) {
        const key = `${target.kind}:${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        requireItem<Entity>(
          {
            note: state.notes,
            task: state.tasks,
            project: state.projects,
            thought: state.thoughts,
          }[target.kind],
          target.id,
          "Linked item",
        );
        if (target.kind === "note" && target.id === note.id)
          throw new PlannerError("invalid", "A note cannot link to itself.");
        const fields = {
          noteId: note.id,
          targetNoteId: null as string | null,
          taskId: null as string | null,
          projectId: null as string | null,
          thoughtId: null as string | null,
        };
        if (target.kind === "note")
          [fields.noteId, fields.targetNoteId] = [note.id, target.id].sort();
        else fields[`${target.kind}Id`] = target.id;
        const old = existing.find(
          (l) =>
            l.noteId === fields.noteId &&
            l.targetNoteId === fields.targetNoteId &&
            l.taskId === fields.taskId &&
            l.projectId === fields.projectId &&
            l.thoughtId === fields.thoughtId,
        );
        state.noteLinks.push(old || { ...entity(), ...fields });
      }
      resultId = note.id;
      break;
    }
    case "note.delete": {
      for (const db of state.noteDatabases)
        if (db.noteId === command.id) {
          db.noteId = null;
          touch(db);
        }
      checkRevision(
        requireItem(state.notes, command.id, "Note"),
        command.expectedUpdatedAt,
      );
      state.notes = state.notes.filter((n) => n.id !== command.id);
      break;
    }
    default: {
      const exhaustive: never = command;
      throw new PlannerError(
        "invalid",
        `Unknown command: ${String(exhaustive)}`,
      );
    }
  }
  state.noteLinks = state.noteLinks.filter(
    (l) =>
      state.notes.some((n) => n.id === l.noteId) &&
      (!l.targetNoteId || state.notes.some((n) => n.id === l.targetNoteId)) &&
      (!l.taskId || state.tasks.some((n) => n.id === l.taskId)) &&
      (!l.projectId || state.projects.some((n) => n.id === l.projectId)) &&
      (!l.thoughtId || state.thoughts.some((n) => n.id === l.thoughtId)),
  );
  state.tasks.sort(
    (a, b) =>
      (a.listPosition ?? 0) - (b.listPosition ?? 0) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  state.projects.sort(
    (a, b) =>
      (a.listPosition ?? 0) - (b.listPosition ?? 0) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  return { snapshot: state, id: resultId };
}
