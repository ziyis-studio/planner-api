import { expect, test, vi } from "vitest";
import { emptyWorkspace } from "../src/domain/model";
import {
  tagList,
  tagListQuery,
  tagOptions,
  tagOptionsQuery,
} from "../src/tag-views";
import { tagGraph, tagGraphQuery } from "../src/tag-graph";
import { createApi } from "../src/app";
import type { ApiRepository } from "../src/repository";
function fixture() {
  const state = emptyWorkspace(),
    stamp = {
      createdAt: "2026-11-22T00:00:00Z",
      updatedAt: "2026-11-22T00:00:00Z",
    },
    project = crypto.randomUUID();
  state.projects.push({
    ...stamp,
    id: project,
    title: "Renovation",
    description: "",
    tags: ["home"],
    completedAt: null,
  });
  state.tasks.push({
    ...stamp,
    id: crypto.randomUUID(),
    title: "Floor survey",
    description: "",
    projectId: project,
    tags: ["testing"],
    completedAt: null,
  });
  state.tasks.push({
    ...stamp,
    id: crypto.randomUUID(),
    title: "Unsorted",
    description: "",
    projectId: null,
    tags: [],
    completedAt: null,
  });
  state.notes.push({
    ...stamp,
    id: crypto.randomUUID(),
    title: "Measurements",
    content: "Floor plan",
    tags: ["home"],
  });
  state.tagCatalog.push({ ...stamp, id: crypto.randomUUID(), name: "unused" });
  return state;
}
test("picker options combine catalog and direct/inherited tags, normalize draft selections and validate creation", () => {
  const state = fixture(),
    before = structuredClone(state),
    result = tagOptions(
      state,
      tagOptionsQuery.parse({
        q: " HOME ",
        selected: ["Testing", "testing", "research, notes"],
      }),
    );
  expect(result.items).toEqual([{ name: "home", items: 3 }]);
  expect(result.selected).toEqual(["testing", "research, notes"]);
  expect(result.create).toBeNull();
  expect(state).toEqual(before);
  expect(
    tagOptions(state, tagOptionsQuery.parse({ q: " Fresh Tag " })).create,
  ).toEqual({ name: "fresh tag", allowed: true });
  expect(
    tagOptions(state, tagOptionsQuery.parse({ q: "x".repeat(41) })).create,
  ).toMatchObject({ allowed: false, reason: expect.any(String) });
  expect(
    tagOptions(
      state,
      tagOptionsQuery.parse({
        q: "new",
        selected: Array.from({ length: 30 }, (_, i) => "tag-" + i),
      }),
    ).create?.allowed,
  ).toBe(false);
  for (let i = 0; i < 75; i++)
    state.tagCatalog.push({
      ...state.tagCatalog[0],
      id: crypto.randomUUID(),
      name: "catalog-" + i,
    });
  expect(tagOptions(state, tagOptionsQuery.parse({})).items).toHaveLength(50);
  expect(
    tagOptions(state, tagOptionsQuery.parse({ q: "catalog-74" })).items,
  ).toEqual([{ name: "catalog-74", items: 0 }]);
});
test("list groups record types, retains unused tags and filters completed and untagged records", () => {
  const state = fixture();
  const page = tagList(state, tagListQuery.parse({ includeUntagged: true }));
  expect(page.rows.find((r) => r.name === "home")).toEqual({
    name: "home",
    count: 3,
    tasks: 1,
    projects: 1,
    notes: 1,
  });
  expect(page.rows.find((r) => r.name === "unused")?.count).toBe(0);
  expect(page.rows.find((r) => r.name === null)?.count).toBe(1);
  const notes = tagList(
    state,
    tagListQuery.parse({ kind: "note", tag: "HOME" }),
  );
  expect(notes.mode).toBe("items");
  expect(notes.items.map((n) => n.label)).toEqual(["Measurements"]);
  expect(notes.items[0]).not.toHaveProperty("search");
  state.tasks[0].completedAt = "2026-11-22T01:00:00Z";
  expect(
    tagList(state, tagListQuery.parse({ includeCompleted: false })).rows.find(
      (r) => r.name === "home",
    )?.count,
  ).toBe(2);
  expect(
    tagList(state, tagListQuery.parse({ onlyUntagged: true })).items.map(
      (i) => i.label,
    ),
  ).toEqual(["Unsorted"]);
});
test("list counts and pagination cover all matching records beyond the graph limit", () => {
  const state = fixture(),
    template = state.tasks[0];
  state.tasks = Array.from({ length: 800 }, (_, i) => ({
    ...template,
    id: crypto.randomUUID(),
    title: "Survey " + String(i).padStart(3, "0"),
    tags: ["unique-" + i],
  }));
  expect(tagGraph(state, tagGraphQuery.parse({})).truncated).toBe(true);
  expect(
    tagList(state, tagListQuery.parse({})).rows.find((r) => r.name === "home")
      ?.count,
  ).toBe(802);
  const first = tagList(state, tagListQuery.parse({ tag: "home", limit: 30 })),
    next = tagList(
      state,
      tagListQuery.parse({ tag: "home", offset: 30, limit: 30 }),
    );
  expect(first.total).toBe(802);
  expect(first.items).toHaveLength(30);
  expect(next.items).toHaveLength(30);
  expect(new Set([...first.items, ...next.items].map((i) => i.id)).size).toBe(
    60,
  );
  expect(
    tagList(state, tagListQuery.parse({ tag: "home", offset: 780, limit: 30 }))
      .items,
  ).toHaveLength(22);
});
test("options and list routes are owner-scoped and sample reads do not access accounts", async () => {
  const state = fixture(),
    load = vi.fn(async () => state),
    authenticate = vi.fn(async () => ({ load }) as unknown as ApiRepository),
    app = createApi(authenticate),
    headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer owner",
    };
  for (const name of ["tag-options", "tag-list"]) {
    expect(
      (
        await app(
          new Request("http://api/v1/" + name, {
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
          new Request("http://api/v1/" + name, {
            method: "POST",
            headers,
            body: JSON.stringify({ owner_id: "elsewhere" }),
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app(
          new Request("http://api/v1/" + name, {
            method: "POST",
            headers,
            body: "{}",
          }),
        )
      ).status,
    ).toBe(200);
    authenticate.mockClear();
    load.mockClear();
    expect(
      (
        await app(
          new Request("http://api/v1/sample/" + name, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspace: state, query: {} }),
          }),
        )
      ).status,
    ).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  }
  expect(
    (
      await app(
        new Request("http://api/v1/tag-list", {
          method: "POST",
          headers,
          body: JSON.stringify({ offset: -1 }),
        }),
      )
    ).status,
  ).toBe(422);
});
