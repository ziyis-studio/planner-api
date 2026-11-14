import { changesBetween } from "../src/cloud-mapping";
import { beforeEach, describe, expect, it } from "vitest";
import { applyCommand } from "../src/domain/commands";
import type { Command } from "../src/domain/commands";
import {
  canCompleteProject,
  canCompleteTask,
  emptyWorkspace,
  taskProgress,
} from "../src/domain/model";
import type { Clock, Workspace } from "../src/domain/model";
import {
  blockKinds,
  plannedMinutes,
  taskBlocks,
  timelineForDay,
} from "../src/domain/selectors";
import { parseWorkspace } from "../src/domain/validation";
import { wallTime } from "../src/domain/time";

let state: Workspace;
let clock: Clock;
const zone = "Asia/Kuala_Lumpur";
function run(command: Command): string {
  const result = applyCommand(state, command, clock);
  state = result.snapshot;
  return result.id!;
}
beforeEach(() => {
  state = emptyWorkspace();
  let serial = 0,
    tick = 0;
  clock = {
    id: () => `10000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
    now: () =>
      new Date(
        Date.parse("2026-10-23T01:00:00Z") + tick++ * 1000,
      ).toISOString(),
  };
});

describe("explicit Task progress from arrangements", () => {
  it("keeps continuing separate from completion, gates completion and preserves the time plan", () => {
    const project = run({
      type: "project.create",
      input: { title: "Prepare release" },
    });
    const id = run({
      type: "task.create",
      input: {
        title: "Review release",
        projectId: project,
        conditions: ["Review approved"],
      },
    });
    run({
      type: "block.save",
      input: {
        title: "",
        startsAt: wallTime("2026-10-23", "09:00", zone),
        endsAt: wallTime("2026-10-23", "10:00", zone),
        timeZone: zone,
        taskIds: [id],
      },
    });
    const plan = structuredClone(state.timeBlocks);
    const oldRevision = state.tasks[0].updatedAt;
    run({ type: "task.continue", id, expectedUpdatedAt: oldRevision });
    expect(taskProgress(state.tasks[0])).toBe("continuing");
    expect(state.tasks[0].completedAt).toBeNull();
    expect(() => run({ type: "task.complete", id })).toThrow(
      "Meet every completion condition",
    );
    expect(() =>
      run({ type: "task.reopen", id, expectedUpdatedAt: oldRevision }),
    ).toThrow("changed elsewhere");
    run({
      type: "condition.update",
      id: state.conditions[0].id,
      patch: { isMet: true },
    });
    run({ type: "task.complete", id });
    run({ type: "project.complete", id: project });
    run({ type: "task.continue", id });
    expect(state.projects[0].completedAt).toBeNull();
    expect(taskProgress(state.tasks[0])).toBe("continuing");
    run({ type: "task.reopen", id });
    expect(taskProgress(state.tasks[0])).toBe("unfinished");
    expect(state.tasks[0].startedAt).toBeNull();
    expect(state.timeBlocks).toEqual(plan);
    expect(state.blockTaskLinks).toHaveLength(1);
    const legacy = structuredClone(state);
    delete legacy.tasks[0].startedAt;
    expect(parseWorkspace(legacy).tasks[0].startedAt).toBeNull();
  });
});

describe("task deadlines", () => {
  it("round-trips optional dates without arranging time or bypassing manual completion", () => {
    const id = run({
      type: "task.create",
      input: {
        title: "Submit draft",
        deadline: "2026-10-22",
        conditions: ["Review draft"],
      },
    });
    const original = structuredClone(state);
    expect(state.tasks[0].deadline).toBe("2026-10-22");
    expect(state.tasks[0].completedAt).toBeNull();
    expect(state.timeBlocks).toHaveLength(0);
    expect(() => run({ type: "task.complete", id })).toThrow(
      "Meet every completion condition",
    );
    expect(() =>
      run({
        type: "task.update",
        id,
        patch: { title: "Invalid edit", deadline: "2026-02-30" },
      }),
    ).toThrow("Choose a valid deadline");
    expect(state).toEqual(original);
    run({ type: "task.update", id, patch: { deadline: "2026-11-30" } });
    expect(
      changesBetween(original, state).find((change) => change.table === "tasks")
        ?.row.deadline,
    ).toBe("2026-11-30");
    run({
      type: "condition.update",
      id: state.conditions[0].id,
      patch: { isMet: true },
    });
    run({ type: "task.complete", id });
    const completedAt = state.tasks[0].completedAt;
    run({ type: "task.update", id, patch: { deadline: null } });
    expect(
      parseWorkspace(JSON.parse(JSON.stringify(state))).tasks[0].deadline,
    ).toBeNull();
    expect(state.tasks[0].completedAt).toBe(completedAt);
    expect(state.timeBlocks).toHaveLength(0);
    const legacy = structuredClone(state);
    delete legacy.tasks[0].deadline;
    expect(parseWorkspace(legacy).tasks[0].deadline).toBeNull();
  });
});

describe("manual task and project completion", () => {
  it("requires all conditions, then a separate task confirmation and a separate project confirmation", () => {
    const project = run({
      type: "project.create",
      input: { title: "Plan the app" },
    });
    const task = run({
      type: "task.create",
      input: {
        title: "Review the brief",
        projectId: project,
        conditions: ["All modules defined", "Review finished"],
      },
    });
    expect(() => run({ type: "task.complete", id: task })).toThrow(
      "Meet every completion condition",
    );
    expect(() => run({ type: "project.complete", id: project })).toThrow(
      "Complete every task",
    );
    for (const condition of state.conditions)
      run({
        type: "condition.update",
        id: condition.id,
        patch: { isMet: true },
      });
    expect(canCompleteTask(state, task)).toBe(true);
    expect(state.tasks[0].completedAt).toBeNull();
    run({ type: "task.complete", id: task });
    expect(canCompleteProject(state, project)).toBe(true);
    expect(state.projects[0].completedAt).toBeNull();
    run({ type: "project.complete", id: project });
    expect(state.projects[0].completedAt).toBeTruthy();
  });

  it("reopens both levels after unchecking or adding a condition, without automatically recompleting them", () => {
    const project = run({
      type: "project.create",
      input: { title: "Project" },
    });
    const task = run({
      type: "task.create",
      input: { title: "Task", projectId: project, conditions: ["Accepted"] },
    });
    const condition = state.conditions[0].id;
    run({ type: "condition.update", id: condition, patch: { isMet: true } });
    run({ type: "task.complete", id: task });
    run({ type: "project.complete", id: project });
    run({ type: "condition.update", id: condition, patch: { isMet: false } });
    expect(state.tasks[0].completedAt).toBeNull();
    expect(state.projects[0].completedAt).toBeNull();
    run({ type: "condition.update", id: condition, patch: { isMet: true } });
    expect(state.tasks[0].completedAt).toBeNull();
    expect(state.projects[0].completedAt).toBeNull();
    run({ type: "task.complete", id: task });
    run({ type: "project.complete", id: project });
    run({
      type: "condition.add",
      taskId: task,
      description: "Another condition",
    });
    expect(state.tasks[0].completedAt).toBeNull();
    expect(state.projects[0].completedAt).toBeNull();
  });

  it("preserves completion for text edits but reopens a completed project when incomplete work joins it", () => {
    const project = run({
      type: "project.create",
      input: { title: "Project" },
    });
    const task = run({
      type: "task.create",
      input: { title: "Task", projectId: project },
    });
    run({ type: "task.complete", id: task });
    run({ type: "project.complete", id: project });
    const taskCompleted = state.tasks[0].completedAt,
      projectCompleted = state.projects[0].completedAt;
    run({
      type: "task.update",
      id: task,
      patch: { title: "Renamed task", description: "More detail" },
    });
    run({
      type: "project.update",
      id: project,
      input: { title: "Renamed project", description: "Updated note" },
    });
    expect(state.tasks[0].completedAt).toBe(taskCompleted);
    expect(state.projects[0].completedAt).toBe(projectCompleted);
    const standalone = run({
      type: "task.create",
      input: { title: "Independent task" },
    });
    expect(
      state.tasks.find((item) => item.id === standalone)?.projectId,
    ).toBeNull();
    run({ type: "task.update", id: standalone, patch: { projectId: project } });
    expect(state.projects[0].completedAt).toBeNull();
  });

  it("rejects a stale edit and leaves the original state unchanged", () => {
    const task = run({ type: "task.create", input: { title: "Task" } });
    const stamp = state.tasks[0].updatedAt;
    run({
      type: "task.update",
      id: task,
      patch: { description: "Another editor" },
    });
    const before = structuredClone(state);
    expect(() =>
      run({
        type: "task.update",
        id: task,
        expectedUpdatedAt: stamp,
        patch: { title: "Stale edit" },
      }),
    ).toThrow("changed elsewhere");
    expect(state).toEqual(before);
  });
});

describe("thought provenance and transaction boundaries", () => {
  it("keeps a thought when creating multiple results and supports multiple source thoughts for one result", () => {
    const a = run({
      type: "thought.create",
      input: { content: "A personal planning space" },
    });
    const b = run({
      type: "thought.create",
      input: { content: "Keep sources connected" },
    });
    const task = run({
      type: "thought.convert",
      thoughtIds: [a, b],
      kind: "task",
      input: { title: "Write the brief" },
    });
    const project = run({
      type: "thought.convert",
      thoughtIds: [a],
      kind: "project",
      input: { title: "Build the planner" },
    });
    run({
      type: "thought.link",
      kind: "task",
      targetId: task,
      thoughtIds: [a, b],
    });
    expect(state.thoughts).toHaveLength(2);
    expect(state.thoughtTaskLinks).toHaveLength(2);
    expect(state.thoughtProjectLinks).toEqual([
      { thoughtId: a, projectId: project },
    ]);
    run({ type: "thought.delete", id: a });
    expect(state.tasks[0].id).toBe(task);
    expect(state.projects[0].id).toBe(project);
    expect(state.thoughtTaskLinks).toEqual([{ thoughtId: b, taskId: task }]);
  });

  it("does not leave a half-created result when a source or condition is invalid", () => {
    const before = structuredClone(state);
    expect(() =>
      run({
        type: "task.create",
        input: { title: "Task", conditions: ["Ready", "   "] },
      }),
    ).toThrow("Condition cannot be empty");
    expect(state).toEqual(before);
    expect(() =>
      run({
        type: "thought.convert",
        thoughtIds: ["missing"],
        kind: "task",
        input: { title: "Orphan" },
      }),
    ).toThrow("Thought no longer exists");
    expect(state).toEqual(before);
  });
});

describe("independent time arrangements", () => {
  it("supports repeated task scheduling and multiple links without completing tasks or habits", () => {
    const a = run({ type: "task.create", input: { title: "Task A" } });
    const b = run({ type: "task.create", input: { title: "Task B" } });
    const habit = run({
      type: "habit.create",
      input: {
        title: "Read",
        timeZone: zone,
        startsOn: "2026-10-23",
        isoWeekdays: [5],
      },
    });
    run({
      type: "occurrences.materialize",
      from: "2026-10-23",
      to: "2026-10-23",
    });
    const occurrence = state.occurrences.find(
      (item) => item.habitId === habit,
    )!.id;
    const common = {
      timeZone: zone,
      startsAt: wallTime("2026-10-23", "10:00", zone),
      endsAt: wallTime("2026-10-23", "10:30", zone),
    };
    const block = run({
      type: "block.save",
      input: {
        ...common,
        title: "Focus session",
        taskIds: [a, a, b],
        occurrenceIds: [occurrence],
      },
    });
    run({
      type: "block.save",
      input: {
        ...common,
        title: "Second session",
        startsAt: wallTime("2026-10-23", "14:00", zone),
        endsAt: wallTime("2026-10-23", "15:00", zone),
        taskIds: [a],
      },
    });
    expect(state.tasks).toHaveLength(2);
    expect(taskBlocks(state, a)).toHaveLength(2);
    expect(blockKinds(state, block)).toEqual(["task", "habit"]);
    expect(state.tasks.every((item) => item.completedAt === null)).toBe(true);
    expect(state.executions).toHaveLength(0);
    run({ type: "block.delete", id: block });
    expect(state.tasks).toHaveLength(2);
    expect(state.occurrences).toHaveLength(1);
    expect(taskBlocks(state, a)).toHaveLength(1);
    const remaining = state.timeBlocks[0].id;
    run({ type: "task.delete", id: a });
    expect(state.timeBlocks[0].id).toBe(remaining);
    expect(blockKinds(state, remaining)).toEqual(["activity"]);
  });

  it("inserts thoughts chronologically without counting them as planned time and clips overnight plans per day", () => {
    run({
      type: "block.save",
      input: {
        title: "Late session",
        timeZone: zone,
        startsAt: wallTime("2026-10-23", "23:45", zone),
        endsAt: wallTime("2026-10-24", "00:15", zone),
      },
    });
    run({
      type: "thought.create",
      input: {
        content: "Remember this",
        recordedAt: wallTime("2026-10-23", "23:50", zone),
      },
    });
    expect(plannedMinutes(state, "2026-10-23", zone)).toBe(15);
    expect(plannedMinutes(state, "2026-10-24", zone)).toBe(15);
    const entries = timelineForDay(state, "2026-10-23", zone);
    expect(entries.map((entry) => entry.type)).toEqual(["block", "thought"]);
    expect(
      timelineForDay(state, "2026-10-24", zone).map((entry) => entry.type),
    ).toEqual(["block"]);
    const recordedAt = state.thoughts[0].createdAt;
    run({
      type: "thought.update",
      id: state.thoughts[0].id,
      input: { title: "Edited", content: "A clearer note" },
    });
    expect(state.thoughts[0].createdAt).toBe(recordedAt);
  });
});

describe("habit history", () => {
  it("materializes fixed weekdays once, reschedules only one occurrence and preserves the actual execution date", () => {
    const habit = run({
      type: "habit.create",
      input: {
        title: "Read",
        timeZone: zone,
        startsOn: "2026-10-19",
        isoWeekdays: [5, 1, 3, 3],
      },
    });
    run({
      type: "occurrences.materialize",
      from: "2026-10-19",
      to: "2026-10-25",
    });
    expect(state.occurrences.map((item) => item.scheduledOn)).toEqual([
      "2026-10-19",
      "2026-10-21",
      "2026-10-23",
    ]);
    const monday = state.occurrences[0].id;
    run({
      type: "occurrence.reschedule",
      id: monday,
      plannedOn: "2026-10-22",
      note: "This occurrence only",
    });
    run({
      type: "occurrences.materialize",
      from: "2026-10-19",
      to: "2026-10-25",
    });
    expect(state.occurrences).toHaveLength(3);
    expect(state.occurrences[0].scheduledOn).toBe("2026-10-19");
    expect(state.occurrences[0].plannedOn).toBe("2026-10-22");
    const execution = run({
      type: "execution.record",
      occurrenceId: monday,
      performedOn: "2026-10-23",
    });
    expect(state.executions[0]).toMatchObject({
      id: execution,
      occurrenceId: monday,
      performedOn: "2026-10-23",
    });
    expect(() =>
      run({
        type: "execution.record",
        occurrenceId: monday,
        performedOn: "2026-10-24",
      }),
    ).toThrow("already recorded");
    expect(state.tasks).toHaveLength(0);
    expect(state.habits[0].isoWeekdays).toEqual([1, 3, 5]);
    run({
      type: "habit.update",
      id: habit,
      input: {
        title: "Read",
        timeZone: zone,
        startsOn: "2026-10-19",
        isoWeekdays: [2],
      },
    });
    expect(state.occurrences).toHaveLength(3);
    expect(state.executions[0].occurrenceId).toBe(monday);
    expect(() => parseWorkspace(state)).not.toThrow();
  });

  it("does not roll missed occurrences forward and allows explicit habit deletion with generated history", () => {
    const habit = run({
      type: "habit.create",
      input: {
        title: "Walk",
        timeZone: zone,
        startsOn: "2026-10-19",
        isoWeekdays: [1, 2, 3, 4, 5, 6, 7],
      },
    });
    run({
      type: "occurrences.materialize",
      from: "2026-10-19",
      to: "2026-10-20",
    });
    run({
      type: "occurrences.materialize",
      from: "2026-10-23",
      to: "2026-10-23",
    });
    expect(state.occurrences[0]).toMatchObject({
      scheduledOn: "2026-10-19",
      plannedOn: "2026-10-19",
    });
    expect(state.executions).toHaveLength(0);
    run({ type: "habit.delete", id: habit });
    expect(state.habits).toHaveLength(0);
    expect(state.occurrences).toHaveLength(0);
    run({
      type: "occurrences.materialize",
      from: "2026-10-19",
      to: "2026-10-25",
    });
    expect(state.occurrences).toHaveLength(0);
  });
});

it("deletes a project while retaining its tasks, completion and linked records", () => {
  const project = run({
    type: "project.create",
    input: { title: "Temporary project" },
  });
  const first = run({
    type: "task.create",
    input: {
      title: "Finished work",
      projectId: project,
      conditions: ["Reviewed"],
    },
  });
  run({
    type: "condition.update",
    id: state.conditions[0].id,
    patch: { isMet: true },
  });
  run({ type: "task.complete", id: first });
  const second = run({
    type: "task.create",
    input: { title: "Next step", projectId: project },
  });
  const thought = run({
    type: "thought.create",
    input: { content: "Source record" },
  });
  run({
    type: "thought.link",
    thoughtIds: [thought],
    kind: "project",
    targetId: project,
  });
  run({
    type: "thought.link",
    thoughtIds: [thought],
    kind: "task",
    targetId: first,
  });
  run({
    type: "note.save",
    input: {
      title: "Related note",
      content: "Keep this note.",
      targets: [
        { kind: "project", id: project },
        { kind: "task", id: first },
      ],
    },
  });
  run({
    type: "block.save",
    input: {
      title: "Shared arrangement",
      startsAt: wallTime("2026-10-23", "09:00", zone),
      endsAt: wallTime("2026-10-23", "10:00", zone),
      timeZone: zone,
      taskIds: [first, second],
    },
  });
  const before = structuredClone(state);
  run({ type: "project.delete", id: project });
  expect(state.projects).toHaveLength(0);
  expect(state.tasks.map((task) => task.projectId)).toEqual([null, null]);
  expect(state.tasks[0].completedAt).toBe(before.tasks[0].completedAt);
  expect(state.tasks[1].completedAt).toBeNull();
  expect(state.conditions).toEqual(before.conditions);
  expect(state.timeBlocks).toEqual(before.timeBlocks);
  expect(state.blockTaskLinks).toEqual(before.blockTaskLinks);
  expect(state.thoughts).toEqual(before.thoughts);
  expect(state.thoughtTaskLinks).toEqual(before.thoughtTaskLinks);
  expect(state.thoughtProjectLinks).toHaveLength(0);
  expect(state.notes).toEqual(before.notes);
  expect(state.noteLinks).toHaveLength(1);
  expect(state.noteLinks[0].taskId).toBe(first);
  const changes = changesBetween(before, state);
  const deletion = changes.findIndex(
    (change) => change.table === "projects" && change.action === "delete",
  );
  const updates = changes.filter(
    (change) => change.table === "tasks" && change.action === "update",
  );
  expect(updates).toHaveLength(2);
  for (const update of updates) {
    expect(changes.indexOf(update)).toBeLessThan(deletion);
    expect(update.row.project_id).toBeNull();
    expect(update.expectedUpdatedAt).toBe(
      before.tasks.find((task) => task.id === update.row.id)!.updatedAt,
    );
  }
  expect(changes[deletion].expectedUpdatedAt).toBe(
    before.projects[0].updatedAt,
  );
});
