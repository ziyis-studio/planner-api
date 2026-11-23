import { expect, test } from "vitest";
import { applyCommand } from "../src/domain/commands";
import { emptyWorkspace } from "../src/domain/model";
import { parseWorkspace } from "../src/domain/validation";
import { recoveryPatch, restorePatch } from "../src/domain/recovery";
import { recurrenceDeletion } from "../src/domain/recurrence-deletion";
import { parseCommand } from "../src/command-schema";

function fixture() {
  const s = applyCommand(emptyWorkspace(), {
    type: "task.create",
    input: {
      title: "testing",
      conditions: ["Checked"],
      recurrence: {
        frequency: "daily",
        interval: 1,
        startsOn: "2026-11-24",
        endsOn: "2026-11-27",
        monthDay: 24,
        time: "09:00",
        duration: 30,
        timeZone: "Asia/Kuala_Lumpur",
      },
    },
  }).snapshot;
  return applyCommand(s, { type: "task.create", input: { title: "testing" } })
    .snapshot;
}
test("deletes active and stopped daily series across all dates, including completed/renamed occurrences; unrelated same-title tasks stay", () => {
  for (const active of [true, false]) {
    const before = fixture(),
      series = before.taskRecurrences[0];
    series.active = active;
    before.tasks[0].completedAt = new Date().toISOString();
    before.conditions[0].isMet = true;
    before.tasks[1].title = "Renamed occurrence";
    before.tasks[1].deadline = "2026-12-02";
    const command = parseCommand({
      type: "task.recurrence.delete",
      id: series.id,
      expectedUpdatedAt: series.updatedAt,
    });
    const after = applyCommand(before, command).snapshot;
    expect(after.taskRecurrences).toHaveLength(0);
    expect(after.tasks).toHaveLength(1);
    expect(after.tasks[0].title).toBe("testing");
    expect(after.tasks[0].recurrenceId).toBeUndefined();
    expect(after.timeBlocks).toHaveLength(0);
    expect(after.conditions).toHaveLength(0);
    expect(after.blockTaskLinks).toHaveLength(0);
    expect(
      applyCommand(after, {
        type: "tasks.materialize",
        from: "2026-11-24",
        to: "2027-05-01",
      }).snapshot,
    ).toEqual(after);
    const restored = restorePatch(after, recoveryPatch(before, after));
    expect(restored.tasks).toHaveLength(before.tasks.length);
    expect(restored.timeBlocks).toEqual(before.timeBlocks);
    expect(restored.taskRecurrences).toEqual(before.taskRecurrences);
    expect(parseWorkspace(restored)).toEqual(restored);
  }
});
test("shared task/habit plans and actual focus records survive while series links and note links are removed and restored", () => {
  const before = fixture(),
    series = before.taskRecurrences[0],
    outside = before.tasks.at(-1)!;
  const [shared, habitBlock, actual, exclusive] = before.timeBlocks;
  before.blockTaskLinks.push({ timeBlockId: shared.id, taskId: outside.id });
  before.habits.push({
    id: crypto.randomUUID(),
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
    title: "Read",
    description: "",
    startsOn: "2026-11-24",
    endsOn: null,
    timeZone: "Asia/Kuala_Lumpur",
    isoWeekdays: [1],
  });
  before.occurrences.push({
    id: crypto.randomUUID(),
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
    habitId: before.habits[0].id,
    scheduledOn: "2026-11-24",
    plannedOn: "2026-11-24",
    timeZone: "Asia/Kuala_Lumpur",
    note: "",
  });
  before.blockOccurrenceLinks.push({
    timeBlockId: habitBlock.id,
    occurrenceId: before.occurrences[0].id,
  });
  actual.recordedType = "focus";
  actual.sourceSessionId = crypto.randomUUID();
  before.notes.push({
    id: crypto.randomUUID(),
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
    title: "Receipt",
    content: "Keep this",
  });
  before.noteLinks.push({
    id: crypto.randomUUID(),
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
    noteId: before.notes[0].id,
    targetNoteId: null,
    taskId: before.tasks[0].id,
    projectId: null,
    thoughtId: null,
  });
  expect([...recurrenceDeletion(before, series.id).blockIds]).toEqual([
    exclusive.id,
  ]);
  const after = applyCommand(before, {
    type: "task.recurrence.delete",
    id: series.id,
    expectedUpdatedAt: series.updatedAt,
  }).snapshot;
  expect(after.timeBlocks.map((b) => b.id)).toEqual([
    shared.id,
    habitBlock.id,
    actual.id,
  ]);
  expect(after.blockTaskLinks).toEqual([
    { timeBlockId: shared.id, taskId: outside.id },
  ]);
  expect(after.blockOccurrenceLinks).toEqual(before.blockOccurrenceLinks);
  expect(after.notes).toEqual(before.notes);
  expect(after.noteLinks).toHaveLength(0);
  const restored = restorePatch(after, recoveryPatch(before, after));
  expect(restored.blockTaskLinks).toHaveLength(before.blockTaskLinks.length);
  expect(restored.noteLinks).toEqual(before.noteLinks);
  expect(parseWorkspace(restored)).toEqual(restored);
});
test("a stale series revision cancels the whole deletion", () => {
  const before = fixture(),
    copy = structuredClone(before),
    series = before.taskRecurrences[0];
  expect(() =>
    applyCommand(before, {
      type: "task.recurrence.delete",
      id: series.id,
      expectedUpdatedAt: "stale",
    }),
  ).toThrow("changed");
  expect(before).toEqual(copy);
});
