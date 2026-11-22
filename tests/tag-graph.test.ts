import { expect, test, vi } from "vitest";
import { emptyWorkspace } from "../src/domain/model";
import { applyCommand } from "../src/domain/commands";
import type { Command } from "../src/domain/commands";
import { tagGraph, tagGraphQuery } from "../src/tag-graph";
import { createApi } from "../src/app";
import type { ApiRepository } from "../src/repository";
function fixture() {
  let state = emptyWorkspace();
  function run(command: Command) {
    const result = applyCommand(state, command);
    state = result.snapshot;
    return result.id!;
  }
  const project = run({
    type: "project.create",
    input: { title: "House Renovation", tags: ["home", "design"] },
  });
  const task = run({
    type: "task.create",
    input: {
      title: "Survey floor",
      projectId: project,
      tags: ["testing", "design"],
    },
  });
  const personal = run({
    type: "task.create",
    input: { title: "Personal task" },
  });
  const note = run({
    type: "note.save",
    input: {
      title: "Floor materials",
      content: "Measurements",
      tags: ["home"],
      targets: [{ kind: "task", id: task }],
    },
  });
  run({ type: "tag.create", name: "unused" });
  return {
    get state() {
      return state;
    },
    run,
    project,
    task,
    personal,
    note,
  };
}
test("a tag graph connects tasks, projects and notes, distinguishes inheritance and includes unused catalog tags", () => {
  const f = fixture(),
    before = structuredClone(f.state),
    graph = tagGraph(f.state, tagGraphQuery.parse({}));
  expect(f.state).toEqual(before);
  expect(graph.shownItems).toBe(3);
  expect(graph.nodes.find((n) => n.id === "task:" + f.task)).toMatchObject({
    projectTitle: "House Renovation",
    tags: ["home", "design", "testing"],
  });
  expect(graph.nodes.find((n) => n.id === "tag:unused")).toMatchObject({
    connections: 0,
  });
  expect(graph.links).toContainEqual({
    source: "task:" + f.task,
    target: "tag:home",
    kind: "tag",
    inherited: true,
  });
  expect(graph.links).toContainEqual({
    source: "task:" + f.task,
    target: "tag:design",
    kind: "tag",
  });
  expect(graph.links).toContainEqual({
    source: "note:" + f.note,
    target: "task:" + f.task,
    kind: "reference",
  });
  expect(graph.availableTags.find((t) => t.name === "home")).toMatchObject({
    items: 3,
  });
  expect(
    new Set(graph.links.map((l) => l.source + "/" + l.target + "/" + l.kind))
      .size,
  ).toBe(graph.links.length);
  expect(graph.nodes.some((n) => n.id === "task:" + f.personal)).toBe(false);
});
test("filters retain item context, include untagged records on request and update on rename/removal", () => {
  const f = fixture();
  const filtered = tagGraph(
    f.state,
    tagGraphQuery.parse({ kind: "task", q: "House Renovation", tag: "HOME" }),
  );
  expect(filtered.shownItems).toBe(1);
  expect(filtered.nodes.find((n) => n.kind === "project")?.context).toBe(true);
  expect(filtered.nodes.some((n) => n.kind === "note")).toBe(false);
  expect(
    tagGraph(f.state, tagGraphQuery.parse({ includeUntagged: true }))
      .shownItems,
  ).toBe(4);
  f.run({ type: "tag.rename", from: "home", to: "design" });
  const merged = tagGraph(f.state, tagGraphQuery.parse({}));
  expect(merged.nodes.some((n) => n.label === "home" && n.kind === "tag")).toBe(
    false,
  );
  expect(merged.availableTags.find((t) => t.name === "design")?.items).toBe(3);
  f.run({ type: "tag.rename", from: "design", to: null });
  expect(
    tagGraph(f.state, tagGraphQuery.parse({})).nodes.some(
      (n) => n.id === "tag:design",
    ),
  ).toBe(false);
  expect(f.state.tasks).toHaveLength(2);
  expect(f.state.notes).toHaveLength(1);
  f.run({ type: "task.complete", id: f.personal });
  expect(
    tagGraph(
      f.state,
      tagGraphQuery.parse({ includeUntagged: true, includeCompleted: false }),
    ).nodes.some((n) => n.id === "task:" + f.personal),
  ).toBe(false);
});
test("large graphs stay bounded and disclose omitted items without dangling edges", () => {
  const f = fixture(),
    task = f.state.tasks[0];
  f.state.tasks = Array.from({ length: 800 }, (_, i) => ({
    ...task,
    id: crypto.randomUUID(),
    title: "Task " + i,
    tags: ["unique-" + i],
  }));
  const graph = tagGraph(f.state, tagGraphQuery.parse({}));
  expect(graph.nodes.length).toBeLessThanOrEqual(600);
  expect(graph.truncated).toBe(true);
  expect(graph.totalMatches).toBe(802);
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.links) {
    expect(ids.has(edge.source)).toBe(true);
    expect(ids.has(edge.target)).toBe(true);
  }
  expect(
    tagGraph(f.state, tagGraphQuery.parse({ q: "unique-799" })).shownItems,
  ).toBe(1);
});
test("graph routes enforce authentication, validate filters and keep sample reads out of account storage", async () => {
  const f = fixture(),
    load = vi.fn(async () => f.state),
    authenticate = vi.fn(async () => ({ load }) as unknown as ApiRepository),
    app = createApi(authenticate);
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer fixture",
  };
  expect(
    (
      await app(
        new Request("http://api/v1/tag-graph", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await app(
        new Request("http://api/v1/tag-graph", {
          method: "POST",
          headers,
          body: JSON.stringify({ owner_id: "another-owner" }),
        }),
      )
    ).status,
  ).toBe(422);
  const real = await app(
    new Request("http://api/v1/tag-graph", {
      method: "POST",
      headers,
      body: "{}",
    }),
  );
  expect(real.status).toBe(200);
  expect(
    (await real.json()).data.nodes.some(
      (n: { label: string }) => n.label === "Floor materials",
    ),
  ).toBe(true);
  authenticate.mockClear();
  load.mockClear();
  const sample = await app(
    new Request("http://api/v1/sample/tag-graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: f.state, query: { kind: "note" } }),
    }),
  );
  expect(sample.status).toBe(200);
  expect((await sample.json()).data.shownItems).toBe(1);
  expect(authenticate).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});
