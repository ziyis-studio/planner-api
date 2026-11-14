import { PlannerError } from "./model.js";
import type { Task, Workspace } from "./model.js";
export function normalizeTags(tags: string[]): string[] {
  const values = [
    ...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
  ];
  if (values.length > 30 || values.some((t) => t.length > 40))
    throw new PlannerError(
      "invalid",
      "Use up to 30 tags, each under 40 characters.",
    );
  return values;
}
export function validWorkStatus(value?: string): "active" | "on_hold" {
  if (value && value !== "active" && value !== "on_hold")
    throw new PlannerError("invalid", "Choose a valid status.");
  return value === "on_hold" ? value : "active";
}
export function effectiveTags(state: Workspace, task: Task): string[] {
  return [
    ...new Set([
      ...(state.projects.find((p) => p.id === task.projectId)?.tags || []),
      ...(task.tags || []),
    ]),
  ];
}
export function availableForSchedule(state: Workspace, task: Task): boolean {
  const project = state.projects.find((p) => p.id === task.projectId);
  return (
    !task.completedAt &&
    task.workStatus !== "on_hold" &&
    project?.workStatus !== "on_hold" &&
    !project?.completedAt
  );
}
