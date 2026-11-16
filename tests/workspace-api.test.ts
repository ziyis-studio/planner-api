import { expect, test } from "vitest";
import { createApi } from "../src/app";
import { emptyWorkspace } from "../src/domain/model";
import { applyCommand } from "../src/domain/commands";
import { parseCommand, commandNames } from "../src/command-schema";
function fixture() {
  let state = emptyWorkspace();
  const app = createApi(async () => ({
    load: async () => state,
    execute: async (command) => {
      const result = applyCommand(state, command);
      state = result.snapshot;
      return result;
    },
  }));
  return {
    request: (path: string, body?: unknown) =>
      app(
        new Request("http://localhost/v1" + path, {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: "Bearer test",
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      ),
    get state() {
      return state;
    },
  };
}
test("column creation persists the requested task and project stages in one command", async () => {
  const f = fixture();
  for (const initialStage of ["todo", "progress", "hold", "done"]) {
    const response = await f.request("/commands", {
      type: "task.create",
      input: { title: initialStage, initialStage },
    });
    expect(response.status).toBe(200);
    const task = f.state.tasks.at(-1)!;
    expect(task.completedAt !== null).toBe(initialStage === "done");
    expect(!!task.startedAt).toBe(
      initialStage === "progress" || initialStage === "done",
    );
    expect(task.workStatus).toBe(
      initialStage === "hold" ? "on_hold" : "active",
    );
  }
  for (const initialStage of ["progress", "hold", "done"]) {
    expect(
      (
        await f.request("/commands", {
          type: "project.create",
          input: { title: initialStage, initialStage },
        })
      ).status,
    ).toBe(200);
    const project = f.state.projects.at(-1)!;
    expect(!!project.completedAt).toBe(initialStage === "done");
    expect(project.workStatus).toBe(
      initialStage === "hold" ? "on_hold" : "active",
    );
  }
  const project = f.state.projects.at(-1)!;
  expect(
    (
      await f.request("/commands", {
        type: "task.create",
        input: {
          title: "Already finished",
          initialStage: "done",
          projectId: project.id,
        },
      })
    ).status,
  ).toBe(200);
  expect(f.state.projects.at(-1)!.completedAt).toBe(project.completedAt);
});
test("invalid creation stages and unmet Done conditions leave no partial records", async () => {
  const f = fixture(),
    original = JSON.stringify(f.state);
  expect(
    (
      await f.request("/commands", {
        type: "task.create",
        input: { title: "Wrong", initialStage: "unknown" },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await f.request("/commands", {
        type: "project.create",
        input: { title: "Wrong", initialStage: "todo" },
      })
    ).status,
  ).toBe(422);
  const response = await f.request("/commands", {
    type: "task.create",
    input: {
      title: "Not done",
      initialStage: "done",
      conditions: ["Verify work"],
    },
  });
  expect(response.ok).toBe(false);
  expect((await response.json()).error.code).toBe("conditions_unmet");
  expect(JSON.stringify(f.state)).toBe(original);
});
test("all application business operations run through the API, preserving completion gates", async () => {
  const f = fixture();
  const run = async (body: unknown) => {
    const r = await f.request("/commands", body);
    expect(r.status).toBe(200);
    return (await r.json()).data;
  };
  const project = await run({
    type: "project.create",
    input: { title: "Renovation", tags: ["home"] },
  });
  const task = await run({
    type: "task.create",
    input: { title: "Kitchen", projectId: project.id, conditions: ["Measure"] },
  });
  expect(
    (await f.request("/commands", { type: "task.complete", id: task.id }))
      .status,
  ).toBe(422);
  await run({
    type: "condition.update",
    id: f.state.conditions[0].id,
    patch: { isMet: true },
  });
  await run({ type: "task.complete", id: task.id });
  await run({ type: "project.complete", id: project.id });
  expect(f.state.projects[0].completedAt).not.toBeNull();
  await run({ type: "task.reopen", id: task.id });
  expect(f.state.projects[0].completedAt).toBeNull();
  await run({ type: "thought.create", input: { content: "An idea" } });
  const habit = await run({
    type: "habit.create",
    input: {
      title: "Water",
      timeZone: "Asia/Kuala_Lumpur",
      startsOn: "2026-11-15",
      isoWeekdays: [1, 2, 3, 4, 5, 6, 7],
    },
  });
  await run({
    type: "occurrences.materialize",
    from: "2026-11-15",
    to: "2026-11-15",
  });
  await run({
    type: "execution.record",
    occurrenceId: f.state.occurrences[0].id,
    performedOn: "2026-11-15",
  });
  await run({
    type: "block.save",
    input: {
      title: "",
      startsAt: "2026-11-15T10:00:00Z",
      endsAt: "2026-11-15T11:00:00Z",
      timeZone: "Asia/Kuala_Lumpur",
      taskIds: [task.id],
    },
  });
  await run({
    type: "sleep.save",
    input: {
      startsAt: "2020-11-14T15:00:00Z",
      endsAt: "2020-11-14T23:00:00Z",
      awakeMinutes: 5,
      timeZone: "Asia/Kuala_Lumpur",
    },
  });
  await run({ type: "tag.create", name: "work" });
  for (const path of [
    "/workspace",
    "/tasks",
    "/projects",
    "/conditions",
    "/thoughts",
    "/habits",
    "/occurrences",
    "/executions",
    "/schedule",
    "/sleep",
    "/tags",
    `/habits/${habit.id}`,
  ])
    expect((await f.request(path)).status).toBe(200);
});
test("rejects arbitrary operations, injected properties, excessive date generation and malformed payloads", () => {
  expect(commandNames.length).toBeGreaterThan(35);
  for (const value of [
    { type: "sql.execute", sql: "bad" },
    {
      type: "task.create",
      input: { title: "T", ownerId: crypto.randomUUID() },
    },
    {
      type: "condition.update",
      id: crypto.randomUUID(),
      patch: { isMet: "true" },
    },
    { type: "occurrences.materialize", from: "2000-01-01", to: "2099-01-01" },
  ])
    expect(() => parseCommand(value)).toThrow();
});
