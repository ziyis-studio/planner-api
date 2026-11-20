import type { Meal } from "./meals.js";
import type { NoteDatabase, DatabaseRecord } from "./note-databases.js";
import type { HabitIconName } from "./habit-icons.js";
import type { ProjectIconName } from "./project-icons.js";

export interface Entity {
  id: string;
  createdAt: string;
  updatedAt: string;
}
export interface Project extends Entity {
  listPosition?: number;
  tags?: string[];
  workStatus?: "active" | "on_hold";
  icon?: ProjectIconName | null;
  title: string;
  description: string;
  completedAt: string | null;
}
export interface Task extends Entity {
  listPosition?: number;
  tags?: string[];
  workStatus?: "active" | "on_hold";
  projectPosition?: number;
  deadline?: string | null;
  startedAt?: string | null;
  title: string;
  description: string;
  projectId: string | null;
  completedAt: string | null;
}
export type TaskProgress = "unfinished" | "continuing" | "completed";
export function taskProgress(task: Task): TaskProgress {
  return task.completedAt
    ? "completed"
    : task.startedAt
      ? "continuing"
      : "unfinished";
}
export interface CompletionCondition extends Entity {
  taskId: string;
  description: string;
  isMet: boolean;
  position: number;
}
export interface Thought extends Entity {
  emotion?: string | null;
  title: string;
  content: string;
}
export interface Note extends Entity {
  tags?: string[];
  title: string;
  content: string;
}
export interface SleepRecord extends Entity {
  startsAt: string;
  endsAt: string;
  awakeMinutes: number;
  timeZone: string;
  note: string;
}
export type NoteTarget = {
  kind: "note" | "task" | "project" | "thought";
  id: string;
};
export interface NoteLink extends Entity {
  noteId: string;
  targetNoteId: string | null;
  taskId: string | null;
  projectId: string | null;
  thoughtId: string | null;
}
export interface Habit extends Entity {
  icon?: HabitIconName | null;
  title: string;
  description: string;
  timeZone: string;
  startsOn: string;
  endsOn: string | null;
  isoWeekdays: number[];
}
export interface HabitOccurrence extends Entity {
  habitId: string;
  scheduledOn: string;
  plannedOn: string;
  timeZone: string;
  note: string;
}
export interface HabitExecution extends Entity {
  habitId: string;
  occurrenceId: string;
  performedOn: string;
  note: string;
}
export interface TimeBlock extends Entity {
  recordedType?: "focus" | "short" | "long" | null;
  sourceSessionId?: string | null;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
}
export interface ThoughtTaskLink {
  thoughtId: string;
  taskId: string;
}
export interface ThoughtProjectLink {
  thoughtId: string;
  projectId: string;
}
export interface BlockTaskLink {
  timeBlockId: string;
  taskId: string;
}
export interface BlockOccurrenceLink {
  timeBlockId: string;
  occurrenceId: string;
}

export interface Workspace {
  schemaVersion: 1;
  tagCatalog: (Entity & { name: string })[];
  projects: Project[];
  tasks: Task[];
  conditions: CompletionCondition[];
  thoughts: Thought[];
  notes: Note[];
  noteDatabases: NoteDatabase[];
  databaseRecords: DatabaseRecord[];
  sleepRecords: SleepRecord[];
  meals: Meal[];
  noteLinks: NoteLink[];
  habits: Habit[];
  occurrences: HabitOccurrence[];
  executions: HabitExecution[];
  timeBlocks: TimeBlock[];
  thoughtTaskLinks: ThoughtTaskLink[];
  thoughtProjectLinks: ThoughtProjectLink[];
  blockTaskLinks: BlockTaskLink[];
  blockOccurrenceLinks: BlockOccurrenceLink[];
}
export const emptyWorkspace = (): Workspace => ({
  schemaVersion: 1,
  tagCatalog: [],
  projects: [],
  tasks: [],
  conditions: [],
  thoughts: [],
  notes: [],
  noteDatabases: [],
  databaseRecords: [],
  sleepRecords: [],
  meals: [],
  noteLinks: [],
  habits: [],
  occurrences: [],
  executions: [],
  timeBlocks: [],
  thoughtTaskLinks: [],
  thoughtProjectLinks: [],
  blockTaskLinks: [],
  blockOccurrenceLinks: [],
});
export interface Preferences {
  pinnedNoteIds?: string[];
  showSeconds?: boolean;
  highContrast?: boolean;
  reduceMotion?: boolean;
  timeZone: string;
  weekStartsOn: 1 | 7;
}
export const defaultPreferences: Preferences = {
  timeZone: "Asia/Kuala_Lumpur",
  weekStartsOn: 1,
};
export type Module =
  | "tags"
  | "today"
  | "planner"
  | "tasks"
  | "projects"
  | "habits"
  | "thoughts"
  | "notes"
  | "settings";
export interface Clock {
  now(): string;
  id(): string;
}
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  id: () => crypto.randomUUID(),
};
export type ErrorCode =
  | "invalid"
  | "missing"
  | "conditions_unmet"
  | "tasks_incomplete"
  | "restricted"
  | "conflict"
  | "storage";
export class PlannerError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}
export function requireItem<T extends { id: string }>(
  items: T[],
  id: string,
  label = "Item",
): T {
  const item = items.find((value) => value.id === id);
  if (!item)
    throw new PlannerError(
      "missing",
      `${label} no longer exists. Refresh and try again.`,
    );
  return item;
}
export function canCompleteTask(state: Workspace, taskId: string): boolean {
  return state.conditions
    .filter((condition) => condition.taskId === taskId)
    .every((condition) => condition.isMet);
}
export function canCompleteProject(
  state: Workspace,
  projectId: string,
): boolean {
  return state.tasks
    .filter((task) => task.projectId === projectId)
    .every((task) => !!task.completedAt);
}
