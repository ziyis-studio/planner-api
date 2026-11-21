import type {
  ActivityLog,
  ActivityPage,
  ActivityQuery,
  LinkedActivityBlock,
} from "./domain/activity.js";
import type { Workspace } from "./domain/model.js";
import { requireItem } from "./domain/model.js";

/** Derive current links on the server, so moving/unlinking a block updates the log. */
export function linkedActivityBlocks(
  state: Workspace,
  query: ActivityQuery,
  now = new Date(),
): LinkedActivityBlock[] {
  requireItem<{ id: string }>(
    query.kind === "task" ? state.tasks : state.projects,
    query.id,
    query.kind === "task" ? "Task" : "Project",
  );
  const tasks = new Map(
    state.tasks
      .filter((task) =>
        query.kind === "task"
          ? task.id === query.id
          : task.projectId === query.id,
      )
      .map((task) => [task.id, task]),
  );
  const links = new Map<string, Map<string, { id: string; title: string }>>();
  for (const link of state.blockTaskLinks) {
    const task = tasks.get(link.taskId);
    if (!task) continue;
    const blockTasks = links.get(link.timeBlockId) || new Map();
    blockTasks.set(task.id, { id: task.id, title: task.title });
    links.set(link.timeBlockId, blockTasks);
  }
  const blocks: LinkedActivityBlock[] = [];
  for (const block of state.timeBlocks) {
    const linked = links.get(block.id);
    if (!linked) continue;
    const related = [...linked.values()].sort(
      (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
    );
    blocks.push({
      id: block.id,
      title:
        block.title.trim() ||
        related.map((t) => t.title).join(", ") ||
        "Time block",
      description: block.description,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      timeZone: block.timeZone,
      recordedType: block.recordedType || null,
      durationMinutes: Math.max(
        1,
        Math.round(
          (Date.parse(block.endsAt) - Date.parse(block.startsAt)) / 60000,
        ),
      ),
      timing:
        Date.parse(block.endsAt) <= now.valueOf()
          ? "past"
          : Date.parse(block.startsAt) <= now.valueOf()
            ? "current"
            : "upcoming",
      tasks: related,
    });
  }
  const rank = { current: 0, upcoming: 1, past: 2 };
  return blocks.sort(
    (a, b) =>
      rank[a.timing] - rank[b.timing] ||
      (a.timing === "past"
        ? b.endsAt.localeCompare(a.endsAt)
        : a.startsAt.localeCompare(b.startsAt)) ||
      a.id.localeCompare(b.id),
  );
}
const compare = (a: ActivityLog, b: ActivityLog) =>
  Date.parse(a.created_at) - Date.parse(b.created_at) ||
  a.id.localeCompare(b.id);
export function sampleActivityPage(
  state: Workspace,
  entries: ActivityLog[],
  query: ActivityQuery,
): ActivityPage {
  const linkedBlocks = linkedActivityBlocks(state, query);
  const tasks = new Set(
    state.tasks
      .filter((task) => task.projectId === query.id)
      .map((task) => task.id),
  );
  const rows = entries
    .filter(
      (row) =>
        (row.target_kind === query.kind && row.target_id === query.id) ||
        (query.kind === "project" &&
          row.target_kind === "task" &&
          tasks.has(row.target_id)),
    )
    .filter(
      (row) =>
        !query.beforeAt ||
        compare(row, {
          ...row,
          created_at: query.beforeAt,
          id: query.beforeId!,
        }) < 0,
    )
    .sort((a, b) => compare(b, a));
  const items = rows.slice(0, 50),
    last = items.at(-1);
  return {
    items,
    next:
      rows.length > 50 && last
        ? { beforeAt: last.created_at, beforeId: last.id }
        : null,
    linkedBlocks,
  };
}
