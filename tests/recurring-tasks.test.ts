import { expect, test } from "vitest";
import { applyCommand } from "../src/domain/commands";
import { emptyWorkspace } from "../src/domain/model";
import { parseWorkspace } from "../src/domain/validation";
import { parseCommand } from "../src/command-schema";
import { recurrenceDates } from "../src/domain/task-recurrence";
import type { RecurrenceRule } from "../src/domain/task-recurrence";
import {
  copyBackup,
  recoveryPatch,
  restorePatch,
} from "../src/domain/recovery";
export const rule: RecurrenceRule = {
  frequency: "monthly",
  interval: 1,
  startsOn: "2026-11-24",
  endsOn: null,
  monthDay: "last",
  time: "09:00",
  duration: 30,
  timeZone: "Asia/Kuala_Lumpur",
};

test("month-end dates honor short months, leap years, intervals and inclusive end bounds", () => {
  expect(recurrenceDates(rule, "2026-11-01", "2027-03-31")).toEqual([
    "2026-11-30",
    "2026-12-31",
    "2027-01-31",
    "2027-02-28",
    "2027-03-31",
  ]);
  expect(
    recurrenceDates(
      { ...rule, startsOn: "2028-01-01", monthDay: 31 },
      "2028-01-01",
      "2028-03-31",
    ),
  ).toEqual(["2028-01-31", "2028-02-29", "2028-03-31"]);
  expect(
    recurrenceDates(
      { ...rule, interval: 2, endsOn: "2027-01-31" },
      "2026-11-24",
      "2027-06-30",
    ),
  ).toEqual(["2026-11-30", "2027-01-31"]);
  expect(
    recurrenceDates(
      { ...rule, frequency: "weekly", interval: 2 },
      "2026-11-24",
      "2026-12-23",
    ),
  ).toEqual(["2026-11-24", "2026-12-08", "2026-12-22"]);
});
test("each generated task and time block are independent, idempotent, movable and condition-gated", () => {
  let s = applyCommand(emptyWorkspace(), {
    type: "task.create",
    input: {
      title: "还网费",
      recurrence: rule,
      conditions: ["Payment confirmed"],
      tags: ["bills"],
    },
  }).snapshot;
  expect(s.tasks.map((t) => t.deadline)).toEqual(["2026-11-30", "2026-12-31"]);
  const first = s.tasks[0],
    second = s.tasks[1];
  expect(new Date(s.timeBlocks[0].startsAt).toISOString()).toBe(
    "2026-11-30T01:00:00.000Z",
  );
  expect(s.blockTaskLinks).toHaveLength(2);
  expect(() =>
    applyCommand(s, { type: "task.complete", id: first.id }),
  ).toThrow("every completion condition");
  s = applyCommand(s, {
    type: "condition.update",
    id: s.conditions.find((c) => c.taskId === first.id)!.id,
    patch: { isMet: true },
  }).snapshot;
  s = applyCommand(s, { type: "task.complete", id: first.id }).snapshot;
  expect(s.tasks.find((t) => t.id === second.id)!.completedAt).toBeNull();
  expect(s.conditions.find((c) => c.taskId === second.id)!.isMet).toBe(false);
  s = applyCommand(s, {
    type: "task.update",
    id: second.id,
    patch: { deadline: "2026-12-29", title: "Pay early" },
  }).snapshot;
  const again = applyCommand(s, {
    type: "tasks.materialize",
    from: "2026-11-01",
    to: "2027-02-28",
  }).snapshot;
  expect(
    again.tasks.filter((t) => t.scheduledOn === "2026-12-31"),
  ).toHaveLength(1);
  expect(again.tasks.find((t) => t.id === second.id)!.deadline).toBe(
    "2026-12-29",
  );
  expect(again.tasks.find((t) => t.deadline === "2027-01-31")!.title).toBe(
    "还网费",
  );
  expect(
    applyCommand(again, {
      type: "tasks.materialize",
      from: "2026-11-01",
      to: "2027-02-28",
    }).snapshot,
  ).toEqual(again);
  expect(parseWorkspace(again)).toEqual(again);
});
test("deleting one occurrence skips only its original date and undo restores both data and skip state", () => {
  const before = applyCommand(emptyWorkspace(), {
    type: "task.create",
    input: { title: "Internet", recurrence: rule },
  }).snapshot;
  const deleted = applyCommand(before, {
    type: "task.delete",
    id: before.tasks[0].id,
  }).snapshot;
  const materialized = applyCommand(deleted, {
    type: "tasks.materialize",
    from: "2026-11-24",
    to: "2027-02-28",
  }).snapshot;
  expect(materialized.tasks.some((t) => t.scheduledOn === "2026-11-30")).toBe(
    false,
  );
  expect(materialized.tasks.some((t) => t.scheduledOn === "2027-02-28")).toBe(
    true,
  );
  const restored = restorePatch(deleted, recoveryPatch(before, deleted));
  expect(restored.tasks.some((t) => t.id === before.tasks[0].id)).toBe(true);
  expect(restored.taskRecurrences[0].skippedOn).toEqual([]);
});
test("stopping a series retains existing records and blocks and prevents future generation", () => {
  let s = applyCommand(emptyWorkspace(), {
    type: "task.create",
    input: { title: "Internet", recurrence: rule },
  }).snapshot;
  const before = structuredClone(s),
    r = s.taskRecurrences[0];
  s = applyCommand(s, {
    type: "task.recurrence.stop",
    id: r.id,
    expectedUpdatedAt: r.updatedAt,
  }).snapshot;
  s = applyCommand(s, {
    type: "tasks.materialize",
    from: "2027-01-01",
    to: "2027-12-31",
  }).snapshot;
  expect(s.tasks).toEqual(before.tasks);
  expect(s.timeBlocks).toEqual(before.timeBlocks);
  expect(() =>
    applyCommand(s, {
      type: "task.recurrence.stop",
      id: r.id,
      expectedUpdatedAt: "stale",
    }),
  ).toThrow("changed");
});
test("existing tasks can become recurring, invalid rules are atomic, backups remap series references", async () => {
  const one = applyCommand(emptyWorkspace(), {
    type: "task.create",
    input: { title: "Internet" },
  }).snapshot;
  expect(() =>
    applyCommand(one, {
      type: "task.update",
      id: one.tasks[0].id,
      patch: {
        title: "Changed",
        recurrence: { ...rule, endsOn: "2026-01-01" },
      },
    }),
  ).toThrow();
  expect(one.tasks[0].title).toBe("Internet");
  expect(() =>
    parseCommand({
      type: "task.create",
      input: { title: "x", recurrence: { ...rule, interval: 0 } },
    }),
  ).toThrow();
  expect(() =>
    applyCommand(one, {
      type: "tasks.materialize",
      from: "2026-01-01",
      to: "2029-01-01",
    }),
  ).toThrow();
  const s = applyCommand(one, {
    type: "task.update",
    id: one.tasks[0].id,
    patch: { recurrence: rule },
  }).snapshot;
  const { backup } = await copyBackup(
    {
      app: "ONE",
      version: 2,
      id: crypto.randomUUID(),
      ownerId: "one",
      exportedAt: new Date().toISOString(),
      workspace: s,
      trash: [],
      activity: [],
      sessions: [],
    },
    "two",
    true,
  );
  expect(backup.workspace.taskRecurrences[0].id).not.toBe(
    s.taskRecurrences[0].id,
  );
  expect(backup.workspace.tasks[0].recurrenceId).toBe(
    backup.workspace.taskRecurrences[0].id,
  );
  expect(parseWorkspace(backup.workspace)).toEqual(backup.workspace);
});
test("DST gaps retain all-day tasks and later days keep the requested local time", () => {
  const s = applyCommand(emptyWorkspace(), {
    type: "task.create",
    input: {
      title: "Early task",
      recurrence: {
        ...rule,
        frequency: "daily",
        startsOn: "2027-03-13",
        endsOn: "2027-03-15",
        time: "02:30",
        timeZone: "America/New_York",
      },
    },
  }).snapshot;
  expect(s.tasks).toHaveLength(3);
  expect(s.timeBlocks).toHaveLength(2);
  expect(s.timeBlocks.map((b) => new Date(b.startsAt).toISOString())).toEqual([
    "2027-03-13T07:30:00.000Z",
    "2027-03-15T06:30:00.000Z",
  ]);
});
