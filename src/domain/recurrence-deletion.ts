import type { Workspace } from "./model.js";

/** Only exclusively linked plans belong to this deletion. Shared plans and actual focus stay. */
export function recurrenceDeletion(state: Workspace, recurrenceId: string) {
  const taskIds = new Set(
    state.tasks.filter((t) => t.recurrenceId === recurrenceId).map((t) => t.id),
  );
  const links = new Map<string, string[]>();
  for (const link of state.blockTaskLinks) {
    const members = links.get(link.timeBlockId) || [];
    members.push(link.taskId);
    links.set(link.timeBlockId, members);
  }
  const habitBlocks = new Set(
    state.blockOccurrenceLinks.map((l) => l.timeBlockId),
  );
  const blockIds = new Set(
    state.timeBlocks
      .filter((block) => {
        const members = links.get(block.id) || [];
        return (
          !block.recordedType &&
          !block.sourceSessionId &&
          !habitBlocks.has(block.id) &&
          members.length > 0 &&
          members.every((id) => taskIds.has(id))
        );
      })
      .map((b) => b.id),
  );
  return { taskIds, blockIds };
}
