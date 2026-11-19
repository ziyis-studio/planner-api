import { expect, test, vi } from "vitest";
import { applyCommand } from "../src/domain/commands";
import { emptyWorkspace } from "../src/domain/model";
import { createApi } from "../src/app";
import { parseCommand } from "../src/command-schema";
import { fileKey, validateFile } from "../src/attachments";
import { sessionBatch } from "../src/sessions";
const rev = (rows: { id: string; updatedAt: string }[]) =>
  rows.map(({ id, updatedAt }) => ({ id, updatedAt }));
test("moving and placing tasks is atomic, revision-checked, and preserves completion gates", () => {
  let state = emptyWorkspace();
  const run = (command: Parameters<typeof applyCommand>[1]) => {
    const result = applyCommand(state, command);
    state = result.snapshot;
    return result.id!;
  };
  const project = run({ type: "project.create", input: { title: "Work" } });
  const first = run({
    type: "task.create",
    input: { title: "First", projectId: project, conditions: ["Review"] },
  });
  const second = run({ type: "task.create", input: { title: "Second" } });
  const task = state.tasks.find((t) => t.id === first)!;
  const original = structuredClone(state);
  expect(() =>
    run({
      type: "task.move",
      id: first,
      stage: "done",
      expectedUpdatedAt: task.updatedAt,
      beforeId: null,
      items: rev(state.tasks),
    }),
  ).toThrow("completion condition");
  expect(state).toEqual(original);
  run({
    type: "task.move",
    id: first,
    stage: "hold",
    expectedUpdatedAt: task.updatedAt,
    beforeId: null,
    items: rev(state.tasks),
  });
  expect(state.tasks.map((t) => t.id)).toEqual([second, first]);
  expect(state.tasks[1].workStatus).toBe("on_hold");
  expect(() =>
    run({
      type: "task.move",
      id: first,
      stage: "progress",
      expectedUpdatedAt: "stale",
    }),
  ).toThrow("changed elsewhere");
  expect(() =>
    run({
      type: "task.reorder",
      items: [...rev(state.tasks), ...rev(state.tasks)],
    }),
  ).toThrow("list changed");
  expect(() =>
    run({
      type: "project.move",
      id: project,
      stage: "done",
      expectedUpdatedAt: state.projects[0].updatedAt,
    }),
  ).toThrow("every task");
  const condition = state.conditions[0];
  run({ type: "condition.update", id: condition.id, patch: { isMet: true } });
  run({
    type: "task.move",
    id: first,
    stage: "done",
    expectedUpdatedAt: state.tasks.find((t) => t.id === first)!.updatedAt,
  });
  run({
    type: "project.move",
    id: project,
    stage: "done",
    expectedUpdatedAt: state.projects[0].updatedAt,
  });
  run({
    type: "task.move",
    id: first,
    stage: "progress",
    expectedUpdatedAt: state.tasks.find((t) => t.id === first)!.updatedAt,
  });
  expect(state.projects[0].completedAt).toBeNull();
  expect(state.tasks.find((t) => t.id === first)?.startedAt).toBeTruthy();
  expect(state.tasks.find((t) => t.id === first)?.workStatus).toBe("active");
});
test("ordering rejects incomplete lists and wire-level owner injection", () => {
  expect(() =>
    parseCommand({
      type: "task.move",
      id: crypto.randomUUID(),
      stage: "done",
      expectedUpdatedAt: "r",
      owner_id: crypto.randomUUID(),
    }),
  ).toThrow();
  const state = applyCommand(emptyWorkspace(), {
    type: "project.create",
    input: { title: "A" },
  }).snapshot;
  expect(() =>
    applyCommand(state, { type: "project.reorder", items: [] }),
  ).toThrow("list changed");
});
test("sample creation and mutation run through the backend without authenticating or touching cloud data", async () => {
  const authenticate = vi.fn();
  const app = createApi(authenticate);
  const response = await app(
    new Request("http://local/v1/sample?zone=Asia%2FKuala_Lumpur"),
  );
  expect(response.status).toBe(200);
  const { data: workspace } = await response.json();
  const result = await app(
    new Request("http://local/v1/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace,
        command: { type: "task.create", input: { title: "Sample only" } },
      }),
    }),
  );
  expect(result.status).toBe(200);
  expect(
    (await result.json()).data.snapshot.tasks.some(
      (t: any) => t.title === "Sample only",
    ),
  ).toBe(true);
  expect(authenticate).not.toHaveBeenCalled();
});
test("session API derives identity from auth and validates timing instead of accepting arbitrary rows", async () => {
  const sessions = {
    save: vi.fn().mockResolvedValue([{ time_block_id: crypto.randomUUID() }]),
    list: vi.fn().mockResolvedValue([]),
  };
  const authenticate = vi.fn().mockResolvedValue({ sessions });
  const app = createApi(authenticate);
  const input = {
    timezone: "Asia/Kuala_Lumpur",
    records: [
      {
        id: crypto.randomUUID(),
        mode: "focus",
        startedAt: Date.now() - 1500000,
        completedAt: Date.now(),
        durationSeconds: 1500,
      },
    ],
  };
  const req = (payload: unknown) =>
    new Request("http://local/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer owned",
      },
      body: JSON.stringify(payload),
    });
  expect((await app(req(input))).status).toBe(200);
  expect(authenticate).toHaveBeenCalledWith("owned");
  expect(
    (await app(req({ ...input, owner_id: crypto.randomUUID() }))).status,
  ).toBe(422);
  expect(() =>
    sessionBatch.parse({
      ...input,
      records: [
        { ...input.records[0], completedAt: input.records[0].startedAt },
      ],
    }),
  ).toThrow();
});
test("attachments reject mismatched formats, oversized content, and path injection", async () => {
  expect(
    fileKey("planner-file://" + crypto.randomUUID() + ".pdf"),
  ).toBeTruthy();
  expect(fileKey("planner-file://../other/file.pdf")).toBeNull();
  expect(
    await validateFile(new Blob(["%PDF-1.7"], { type: "application/pdf" })),
  ).toBe("pdf");
  await expect(
    validateFile(new Blob(["<script>"], { type: "application/pdf" })),
  ).rejects.toThrow("contents");
  await expect(
    validateFile(new Blob(["<svg/>"], { type: "image/svg+xml" })),
  ).rejects.toThrow("Choose");
  await expect(
    validateFile(
      new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: "text/plain" }),
    ),
  ).rejects.toThrow("3 MB");
});
