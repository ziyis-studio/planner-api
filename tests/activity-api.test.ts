import { test, expect, vi } from "vitest";
import { emptyWorkspace } from "../src/domain/model";
import { createApi } from "../src/app";
import type { ApiRepository } from "../src/repository";
const activity = {
  list: vi.fn(async () => ({ items: [], next: null })),
  append: vi.fn(async () => ({ id: crypto.randomUUID() })),
};
const state = emptyWorkspace();
const app = createApi(
  async () =>
    ({ activity, load: async () => state }) as unknown as ApiRepository,
);
const call = (path: string, options: RequestInit = {}) =>
  app(
    new Request("http://localhost" + path, {
      ...options,
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
    }),
  );
test("activity requires authentication and validates target, comment and keyset cursor", async () => {
  expect((await app(new Request("http://localhost/v1/activity"))).status).toBe(
    401,
  );
  const id = crypto.randomUUID();
  state.projects.push({
    id,
    title: "Project",
    description: "",
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  expect((await call("/v1/activity?kind=project&id=" + id)).status).toBe(200);
  expect(activity.list).toHaveBeenCalledWith({ kind: "project", id });
  expect(
    (
      await call(
        "/v1/activity?kind=task&id=" + id + "&beforeAt=2026-11-19T00:00:00Z",
      )
    ).status,
  ).toBe(422);
  const input = {
    id: crypto.randomUUID(),
    kind: "task",
    targetId: id,
    body: " note ",
  };
  expect(
    (
      await call("/v1/activity", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(201);
  expect(activity.append).toHaveBeenCalledWith({ ...input, body: "note" });
  expect(
    (
      await call("/v1/activity", {
        method: "POST",
        body: JSON.stringify({ ...input, owner_id: crypto.randomUUID() }),
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call("/v1/activity", {
        method: "POST",
        body: JSON.stringify({ ...input, body: " " }),
      })
    ).status,
  ).toBe(422);
});
