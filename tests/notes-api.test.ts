import { expect, test } from "vitest";
import { createApi } from "../src/app";
import { ApiError } from "../src/repository";
import { emptyWorkspace } from "../src/domain/model";
import { applyCommand } from "../src/domain/commands";
function fixture() {
  let state = emptyWorkspace();
  const app = createApi(
    async (token) => {
      if (token !== "test")
        throw new ApiError(401, "unauthorized", "Invalid token.");
      return {
        load: async () => state,
        execute: async (command) => {
          const result = applyCommand(state, command);
          state = result.snapshot;
          return result;
        },
      };
    },
    ["https://app.example"],
  );
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    revision?: string,
  ) =>
    app(
      new Request(`http://localhost/v1${path}`, {
        method,
        headers: {
          Authorization: "Bearer test",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(revision ? { "If-Match": revision } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  return { app, request };
}
test("notes API CRUD, partial edits, ETags and invalid requests", async () => {
  const { request } = fixture();
  const created = await request("/notes", "POST", {
    title: "Page",
    content: "# Heading",
    tags: ["work"],
  });
  expect(created.status).toBe(201);
  const { data: note } = await created.json();
  expect(
    (await request(`/notes/${note.id}`, "PATCH", { title: "Updated" })).status,
  ).toBe(428);
  expect(
    (await request(`/notes/${note.id}`, "PATCH", { title: "Updated" }, "old"))
      .status,
  ).toBe(412);
  const updated = await request(
    `/notes/${note.id}`,
    "PATCH",
    { title: "Updated" },
    created.headers.get("etag")!,
  );
  expect(updated.status).toBe(200);
  expect((await updated.json()).data.content).toBe("# Heading");
  expect(
    (await request("/notes", "POST", { title: "Bad", owner_id: "fake" }))
      .status,
  ).toBe(422);
  expect((await request("/notes?limit=-1")).status).toBe(422);
  expect(
    (
      await request(
        `/notes/${note.id}`,
        "DELETE",
        undefined,
        updated.headers.get("etag")!,
      )
    ).status,
  ).toBe(204);
  expect((await request(`/notes/${note.id}`)).status).toBe(404);
});
test("database API typed properties, record pagination, schema conflict and cascade", async () => {
  const { request } = fixture();
  const field = crypto.randomUUID();
  const response = await request("/databases", "POST", {
    title: "Purchases",
    fields: [{ id: field, name: "Price", type: "number", options: [] }],
  });
  expect(response.status).toBe(201);
  const { data: db } = await response.json();
  for (const price of [100, 2])
    expect(
      (
        await request(`/databases/${db.id}/records`, "POST", {
          title: `Price ${price}`,
          databaseRevision: db.updatedAt,
          values: { [field]: price },
        })
      ).status,
    ).toBe(201);
  const page = await (
    await request(`/databases/${db.id}/records?sort=${field}&limit=1`)
  ).json();
  expect(page.meta.total).toBe(2);
  expect(page.data[0].values[field]).toBe(2);
  expect(
    (
      await request(`/databases/${db.id}/records`, "POST", {
        title: "Invalid",
        databaseRevision: db.updatedAt,
        values: { [field]: "wrong" },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await request(`/databases/${db.id}/records`, "POST", {
        title: "Stale",
        databaseRevision: "old",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        `/databases/${db.id}`,
        "DELETE",
        undefined,
        response.headers.get("etag")!,
      )
    ).status,
  ).toBe(204);
  expect((await request(`/records/${page.data[0].id}`)).status).toBe(404);
});
test("authentication, CORS and request size limits", async () => {
  const { app } = fixture();
  expect((await app(new Request("http://localhost/v1/notes"))).status).toBe(
    401,
  );
  expect(
    (
      await app(
        new Request("http://localhost/v1/notes", {
          headers: { Authorization: "Bearer other" },
        }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await app(
        new Request("http://localhost/v1/health", {
          headers: { Origin: "https://evil.example" },
        }),
      )
    ).status,
  ).toBe(403);
  const preflight = await app(
    new Request("http://localhost/v1/notes", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example" },
    }),
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe(
    "https://app.example",
  );
  expect(
    (
      await app(
        new Request("http://localhost/v1/notes", {
          method: "POST",
          headers: {
            Authorization: "Bearer test",
            "Content-Type": "application/json",
          },
          body: "x".repeat(1_048_577),
        }),
      )
    ).status,
  ).toBe(413);
});
