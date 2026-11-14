import type { Task, TimeBlock, Workspace } from "./model";
import { taskBlocks } from "./selectors";

export type TaskScheduleStatus =
  "unscheduled" | "scheduled" | "active" | "past" | "completed";
export function taskSchedule(state: Workspace, tasks: Task[], now: number) {
  const unfinished = tasks.filter((task) => !task.completedAt);
  const members = unfinished.length ? unfinished : tasks;
  const schedules = members.map((task) => taskBlocks(state, task.id));
  const blocks = [
    ...new Map(schedules.flat().map((block) => [block.id, block])).values(),
  ].sort(
    (a, b) =>
      Date.parse(a.startsAt) - Date.parse(b.startsAt) ||
      a.id.localeCompare(b.id),
  );
  const active = (block: TimeBlock) =>
    Date.parse(block.startsAt) <= now && Date.parse(block.endsAt) > now;
  const future = (block: TimeBlock) => Date.parse(block.startsAt) > now;
  const activeBlocks = blocks.filter(active);
  const next = blocks.find(future);
  const status: TaskScheduleStatus = !unfinished.length
    ? "completed"
    : activeBlocks.length
      ? "active"
      : next
        ? "scheduled"
        : blocks.length
          ? "past"
          : "unscheduled";
  const last = blocks.reduce<TimeBlock | undefined>(
    (latest, block) =>
      !latest || Date.parse(block.endsAt) > Date.parse(latest.endsAt)
        ? block
        : latest,
    undefined,
  );
  return {
    status,
    blocks,
    focus:
      status === "completed" ? undefined : (activeBlocks[0] ?? next ?? last),
    activeTasks: unfinished.length
      ? schedules.filter((items) => items.some(active)).length
      : 0,
    scheduledTasks: unfinished.length
      ? schedules.filter((items) =>
          items.some((block) => Date.parse(block.endsAt) > now),
        ).length
      : 0,
    totalTasks: tasks.length,
    // Status changes at exact starts/ends, rather than on a page-wide clock tick.
    nextChange:
      status === "completed"
        ? undefined
        : blocks
            .flatMap((block) => [
              Date.parse(block.startsAt),
              Date.parse(block.endsAt),
            ])
            .filter((at) => at > now)
            .sort((a, b) => a - b)[0],
  };
}
