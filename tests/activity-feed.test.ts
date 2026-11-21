import { expect, test } from "vitest";
import { applyCommand } from "../src/domain/commands";
import type { Command } from "../src/domain/commands";
import { emptyWorkspace } from "../src/domain/model";
import { linkedActivityBlocks, sampleActivityPage } from "../src/activity-feed";
import { createApi } from "../src/app";
import type { ApiRepository } from "../src/repository";
function fixture() {
  let state = emptyWorkspace();
  const run = (command: Command) => {
    const r = applyCommand(state, command);
    state = r.snapshot;
    return r.id!;
  };
  const project = run({ type: "project.create", input: { title: "ONE" } }),
    other = run({ type: "project.create", input: { title: "Other" } });
  const task = run({
      type: "task.create",
      input: { title: "Study", projectId: project },
    }),
    sibling = run({
      type: "task.create",
      input: { title: "Review", projectId: project },
    }),
    outside = run({
      type: "task.create",
      input: { title: "Outside", projectId: other },
    });
  const current = run({
    type: "block.save",
    input: {
      title: "Shared study",
      startsAt: "2026-11-21T02:00:00Z",
      endsAt: "2026-11-21T04:00:00Z",
      timeZone: "Asia/Kuala_Lumpur",
      taskIds: [task, sibling],
    },
  });
  const upcoming = run({
    type: "block.save",
    input: {
      title: "Tomorrow",
      startsAt: "2026-11-22T02:00:00Z",
      endsAt: "2026-11-22T03:00:00Z",
      timeZone: "Asia/Kuala_Lumpur",
      taskIds: [task],
    },
  });
  const past = run({
    type: "block.save",
    input: {
      title: "Yesterday",
      startsAt: "2026-11-20T02:00:00Z",
      endsAt: "2026-11-20T03:00:00Z",
      timeZone: "Asia/Kuala_Lumpur",
      taskIds: [task],
    },
  });
  run({
    type: "block.save",
    input: {
      title: "Private other project",
      startsAt: "2026-11-22T05:00:00Z",
      endsAt: "2026-11-22T06:00:00Z",
      timeZone: "UTC",
      taskIds: [outside],
    },
  });
  return { state, project, task, sibling, current, upcoming, past };
}
test("task and project logs include current links once, with upcoming and past times and no unrelated blocks", () => {
  const f = fixture(),
    now = new Date("2026-11-21T03:00:00Z");
  const task = linkedActivityBlocks(f.state, { kind: "task", id: f.task }, now);
  expect(task.map((b) => b.id)).toEqual([f.current, f.upcoming, f.past]);
  expect(task.map((b) => b.timing)).toEqual(["current", "upcoming", "past"]);
  expect(task[0].durationMinutes).toBe(120);
  const project = linkedActivityBlocks(
    f.state,
    { kind: "project", id: f.project },
    now,
  );
  expect(project).toHaveLength(3);
  expect(new Set(project[0].tasks.map((t) => t.id))).toEqual(
    new Set([f.task, f.sibling]),
  );
  f.state.timeBlocks.find((b) => b.id === f.current)!.title =
    "Rescheduled title";
  expect(
    linkedActivityBlocks(f.state, { kind: "task", id: f.task }, now)[0].title,
  ).toBe("Rescheduled title");
  f.state.blockTaskLinks = f.state.blockTaskLinks.filter(
    (l) => l.taskId !== f.task,
  );
  expect(
    linkedActivityBlocks(f.state, { kind: "task", id: f.task }, now),
  ).toHaveLength(0);
  expect(
    linkedActivityBlocks(f.state, { kind: "project", id: f.project }, now),
  ).toHaveLength(1);
  expect(() =>
    linkedActivityBlocks(
      f.state,
      { kind: "task", id: crypto.randomUUID() },
      now,
    ),
  ).toThrow(/no longer exists/);
});
test("sample feed retains written entry pagination and adds linked blocks without generating duplicate comments", () => {
  const f = fixture(),
    entries = Array.from({ length: 52 }, (_, i) => ({
      id: crypto.randomUUID(),
      target_kind: "task" as const,
      target_id: f.task,
      body: "Entry " + i,
      created_at: new Date(Date.UTC(2026, 10, 21, 0, i)).toISOString(),
    }));
  const page = sampleActivityPage(f.state, entries, {
    kind: "project",
    id: f.project,
  });
  expect(page.items).toHaveLength(50);
  expect(page.linkedBlocks).toHaveLength(3);
  const older = sampleActivityPage(f.state, entries, {
    kind: "project",
    id: f.project,
    ...page.next!,
  });
  expect(older.items).toHaveLength(2);
  expect(new Set([...page.items, ...older.items].map((e) => e.id)).size).toBe(
    52,
  );
  expect(older.next).toBeNull();
  expect(entries).toHaveLength(52);
});
test("authenticated and sample activity routes return linked blocks and reject missing targets", async () => {
  const f = fixture();
  const app = createApi(
    async () =>
      ({
        load: async () => f.state,
        activity: { list: async () => ({ items: [], next: null }) },
      }) as unknown as ApiRepository,
  );
  const headers = {
    Authorization: "Bearer fixture",
    "content-type": "application/json",
  };
  const response = await app(
    new Request(`http://api/v1/activity?kind=task&id=${f.task}&path=activity`, {
      headers,
    }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).data.linkedBlocks).toHaveLength(3);
  const sample = await app(
    new Request("http://api/v1/sample/activity-feed", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace: f.state,
        items: [],
        query: { kind: "task", id: f.task },
      }),
    }),
  );
  expect(sample.status).toBe(200);
  expect((await sample.json()).data.linkedBlocks).toHaveLength(3);
  const missing = await app(
    new Request(`http://api/v1/activity?kind=task&id=${crypto.randomUUID()}`, {
      headers,
    }),
  );
  expect(missing.status).toBe(404);
});
