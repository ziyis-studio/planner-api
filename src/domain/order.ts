import type { CompletionCondition, Task, Workspace } from "./model.js";

export const compareProjectTasks = (a: Task, b: Task) =>
  (a.projectPosition ?? 0) - (b.projectPosition ?? 0) ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id);
export const projectTasks = (state: Workspace, projectId: string) =>
  state.tasks
    .filter((task) => task.projectId === projectId)
    .sort(compareProjectTasks);
export const taskConditions = (state: Workspace, taskId: string) =>
  state.conditions
    .filter((condition) => condition.taskId === taskId)
    .sort(
      (a: CompletionCondition, b: CompletionCondition) =>
        a.position - b.position ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  const result = [...items];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}
