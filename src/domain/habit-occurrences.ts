import type { Workspace } from "./model.js";

/** Discard only unused default occurrences before the routine's start. */
export function reconcileHabitStarts(
  state: Workspace,
  habitId?: string,
): Set<string> {
  const starts = new Map(
    state.habits
      .filter((habit) => !habitId || habit.id === habitId)
      .map((habit) => [habit.id, habit.startsOn]),
  );
  const protectedIds = new Set([
    ...state.executions.map((execution) => execution.occurrenceId),
    ...state.blockOccurrenceLinks.map((link) => link.occurrenceId),
  ]);
  const changed = new Set<string>();
  state.occurrences = state.occurrences.filter((occurrence) => {
    const start = starts.get(occurrence.habitId);
    if (
      !start ||
      occurrence.scheduledOn >= start ||
      occurrence.plannedOn !== occurrence.scheduledOn ||
      occurrence.note !== "" ||
      protectedIds.has(occurrence.id)
    )
      return true;
    changed.add(occurrence.habitId);
    return false;
  });
  return changed;
}
