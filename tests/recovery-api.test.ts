import { test, expect, vi } from "vitest";
import { createApi } from "../src/app";
import type { ApiRepository } from "../src/repository";
const recovery = {
  list: vi.fn(async () => []),
  restore: vi.fn(async () => ({ snapshot: {} })),
  purge: vi.fn(async () => {}),
  backup: vi.fn(async () => ({ app: "ONE", version: 2 })),
  import: vi.fn(async () => ({ snapshot: {}, idMap: {} })),
};
const app = createApi(async () => ({ recovery }) as unknown as ApiRepository);
const request = (path: string, options: RequestInit = {}) =>
  app(
    new Request("http://localhost" + path, {
      ...options,
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
    }),
  );
test("backup and recovery routes require a session and dispatch bounded, owner-scoped actions", async () => {
  expect((await app(new Request("http://localhost/v1/backup"))).status).toBe(
    401,
  );
  expect((await request("/v1/backup")).status).toBe(200);
  expect(recovery.backup).toHaveBeenCalledOnce();
  const id = crypto.randomUUID();
  expect(
    (await request("/v1/recovery/" + id + "/restore", { method: "POST" }))
      .status,
  ).toBe(200);
  expect(recovery.restore).toHaveBeenCalledWith(id);
  expect(
    (await request("/v1/recovery/" + id, { method: "DELETE" })).status,
  ).toBe(200);
  expect(recovery.purge).toHaveBeenCalledWith(id);
  expect((await request("/v1/recovery?offset=-1")).status).toBe(422);
  expect(
    (
      await request("/v1/backup", {
        method: "POST",
        body: JSON.stringify({ backup: { app: "ONE" }, asCopy: true }),
      })
    ).status,
  ).toBe(200);
  expect(recovery.import).toHaveBeenCalledWith({ app: "ONE" }, true);
  const count = recovery.import.mock.calls.length;
  expect(
    (
      await request("/v1/backup", {
        method: "POST",
        body: JSON.stringify({ backup: "x".repeat(3_500_001) }),
      })
    ).status,
  ).toBe(413);
  expect(recovery.import.mock.calls).toHaveLength(count);
});
