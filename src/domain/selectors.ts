import { availableForSchedule } from "./tags.js";
import type {
  HabitOccurrence,
  Task,
  Thought,
  TimeBlock,
  Workspace,
} from "./model.js";
import { dayBounds, dayKey } from "./time.js";

export type TimelineKind = "task" | "habit" | "activity" | "thought";
export type TimelineEntry =
  | {
      type: "thought";
      id: string;
      at: string;
      kinds: ["thought"];
      thought: Thought;
    }
  | {
      type: "block";
      id: string;
      at: string;
      kinds: TimelineKind[];
      block: TimeBlock;
    };

export function taskBlocks(state: Workspace, taskId: string): TimeBlock[] {
  const ids = new Set(
    state.blockTaskLinks
      .filter((link) => link.taskId === taskId)
      .map((link) => link.timeBlockId),
  );
  return state.timeBlocks
    .filter((block) => ids.has(block.id))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
/** Calendar deadlines are all-day Task references, separate from timed entries. */
export function taskDeadlinesForDay(state: Workspace, day: string): Task[] {
  return state.tasks
    .filter((task) => task.deadline === day)
    .sort(
      (a, b) =>
        Number(!!a.completedAt) - Number(!!b.completedAt) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
}
export function blockTaskIds(state: Workspace, blockId: string): string[] {
  return state.blockTaskLinks
    .filter((link) => link.timeBlockId === blockId)
    .map((link) => link.taskId);
}
export function blockOccurrenceIds(
  state: Workspace,
  blockId: string,
): string[] {
  return state.blockOccurrenceLinks
    .filter((link) => link.timeBlockId === blockId)
    .map((link) => link.occurrenceId);
}
export function blockKinds(state: Workspace, blockId: string): TimelineKind[] {
  const result: TimelineKind[] = [];
  if (state.blockTaskLinks.some((link) => link.timeBlockId === blockId))
    result.push("task");
  if (state.blockOccurrenceLinks.some((link) => link.timeBlockId === blockId))
    result.push("habit");
  return result.length ? result : ["activity"];
}
export function blockTitle(state: Workspace, block: TimeBlock): string {
  if (block.title) return block.title;
  const taskTitles = blockTaskIds(state, block.id)
    .map((id) => state.tasks.find((task) => task.id === id)?.title)
    .filter(Boolean);
  const habitTitles = blockOccurrenceIds(state, block.id)
    .map((id) => {
      const occurrence = state.occurrences.find((item) => item.id === id);
      return state.habits.find((habit) => habit.id === occurrence?.habitId)
        ?.title;
    })
    .filter(Boolean);
  return [...taskTitles, ...habitTitles].join(" · ") || "Activity";
}
export function timelineForDay(
  state: Workspace,
  day: string,
  timeZone: string,
): TimelineEntry[] {
  const [start, end] = dayBounds(day, timeZone);
  const blocks: TimelineEntry[] = state.timeBlocks
    .filter(
      (block) =>
        Date.parse(block.startsAt) < end && Date.parse(block.endsAt) > start,
    )
    .map((block) => ({
      type: "block",
      id: block.id,
      at: new Date(Math.max(start, Date.parse(block.startsAt))).toISOString(),
      kinds: blockKinds(state, block.id),
      block,
    }));
  const thoughts: TimelineEntry[] = state.thoughts
    .filter((thought) => dayKey(thought.createdAt, timeZone) === day)
    .map((thought) => ({
      type: "thought",
      id: thought.id,
      at: thought.createdAt,
      kinds: ["thought"],
      thought,
    }));
  return [...blocks, ...thoughts].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  );
}
export function plannedMinutes(
  state: Workspace,
  day: string,
  timeZone: string,
): number {
  const [start, end] = dayBounds(day, timeZone);
  return state.timeBlocks.reduce(
    (sum, block) =>
      sum +
      Math.max(
        0,
        Math.min(end, Date.parse(block.endsAt)) -
          Math.max(start, Date.parse(block.startsAt)),
      ) /
        60_000,
    0,
  );
}
export function unscheduledTasks(state: Workspace): Task[] {
  const scheduled = new Set(state.blockTaskLinks.map((link) => link.taskId));
  return state.tasks.filter(
    (task) => availableForSchedule(state, task) && !scheduled.has(task.id),
  );
}
export function tasksToHandle(
  state: Workspace,
  day: string,
  timeZone: string,
): Task[] {
  const [, end] = dayBounds(day, timeZone);
  return state.tasks
    .filter((task) => {
      if (!availableForSchedule(state, task)) return false;
      const blocks = taskBlocks(state, task.id);
      return (
        (!!task.deadline && task.deadline <= day) ||
        !blocks.length ||
        blocks.some((block) => dayKey(block.startsAt, timeZone) === day) ||
        blocks.every((block) => Date.parse(block.endsAt) <= end)
      );
    })
    .sort((a, b) => {
      const at = taskBlocks(state, a.id).find(
        (block) => dayKey(block.startsAt, timeZone) === day,
      )?.startsAt;
      const bt = taskBlocks(state, b.id).find(
        (block) => dayKey(block.startsAt, timeZone) === day,
      )?.startsAt;
      return (
        (at ? Date.parse(at) : Infinity) - (bt ? Date.parse(bt) : Infinity) ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt)
      );
    });
}
export function occurrencesForDay(
  state: Workspace,
  day: string,
): HabitOccurrence[] {
  return state.occurrences
    .filter((occurrence) => occurrence.plannedOn === day)
    .sort(
      (a, b) =>
        a.scheduledOn.localeCompare(b.scheduledOn) || a.id.localeCompare(b.id),
    );
}
export function thoughtSources(
  state: Workspace,
  kind: "task" | "project",
  id: string,
): Thought[] {
  const sourceIds = new Set(
    kind === "task"
      ? state.thoughtTaskLinks
          .filter((link) => link.taskId === id)
          .map((link) => link.thoughtId)
      : state.thoughtProjectLinks
          .filter((link) => link.projectId === id)
          .map((link) => link.thoughtId),
  );
  return state.thoughts.filter((thought) => sourceIds.has(thought.id));
}
