import type { Task, Workspace } from "./model.js";
import { availableForSchedule } from "./tags.js";
import { taskBlocks } from "./selectors.js";
import { dayBounds } from "./time.js";

export function taskWorkState(state: Workspace, task: Task) {
  if (task.completedAt) return "completed";
  return availableForSchedule(state, task) ? "active" : "on_hold";
}
export function todayTaskView(
  state: Workspace,
  day: string,
  zone: string,
  category: string,
  sort: string,
  query = "",
) {
  const [from, to] = dayBounds(day, zone);
  const blocks = new Map(
    state.tasks.map((task) => [task.id, taskBlocks(state, task.id)]),
  );
  const planTime = (task: Task) => {
    const plans = blocks.get(task.id) || [];
    const next = plans.find((block) => Date.parse(block.endsAt) > from);
    return next
      ? Date.parse(next.startsAt)
      : plans.length
        ? Date.parse(plans[plans.length - 1].startsAt)
        : Infinity;
  };
  return state.tasks
    .filter((task) => {
      if (!availableForSchedule(state, task)) return false;
      const project = state.projects.find((p) => p.id === task.projectId);
      if (
        !`${task.title} ${project?.title || ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      )
        return false;
      const plans = blocks.get(task.id) || [];
      return (
        category === "all" ||
        (category === "unscheduled"
          ? !plans.length
          : (!!task.deadline && task.deadline <= day) ||
            plans.some(
              (block) =>
                Date.parse(block.startsAt) < to &&
                Date.parse(block.endsAt) > from,
            ))
      );
    })
    .sort(
      (a, b) =>
        (sort === "deadline"
          ? (a.deadline || "9999").localeCompare(b.deadline || "9999")
          : sort === "plan"
            ? planTime(a) === planTime(b)
              ? 0
              : planTime(a) < planTime(b)
                ? -1
                : 1
            : 0) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
}
