import { emptyWorkspace } from "../src/domain/model";
import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activityRepository } from "../src/activity";
import { createApi } from "../src/app";
import type { ApiRepository } from "../src/repository";

test("database log responses normalize timestamp spellings without losing cursor microseconds", async () => {
  const target = crypto.randomUUID();
  const rows = Array.from({ length: 51 }, (_, i) => ({
    id: crypto.randomUUID(),
    target_kind: "project",
    target_id: target,
    body: "Saved entry",
    created_at: `2026-11-19 16:45:58.${123499 - i}+00`,
  }));
  const rpc = vi.fn(async () => ({ data: rows, error: null }));
  const repo = activityRepository({ rpc } as unknown as SupabaseClient);
  const page = await repo.list({ kind: "project", id: target });
  expect(page.items).toHaveLength(50);
  expect(page.items[0].created_at).toBe("2026-11-19T16:45:58.123499+00:00");
  expect(page.next?.beforeAt).toBe("2026-11-19T16:45:58.123450+00:00");
  rpc.mockResolvedValueOnce({ data: rows[0] as any, error: null });
  expect(
    (
      await repo.append({
        id: rows[0].id,
        kind: "project",
        targetId: target,
        body: "Saved entry",
      })
    ).id,
  ).toBe(rows[0].id);
  rpc.mockResolvedValueOnce({
    data: [{ ...rows[0], created_at: "broken" }],
    error: null,
  });
  await expect(
    repo.list({ kind: "project", id: target }),
  ).rejects.toMatchObject({ status: 503, code: "activity_response_invalid" });
});

test("activity reads ignore rewrite metadata while validating the target and full pagination cursor", async () => {
  const list = vi.fn(async () => ({ items: [], next: null })),
    id = crypto.randomUUID();
  const state = emptyWorkspace();
  state.projects.push({
    id,
    title: "Project",
    description: "",
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const app = createApi(
    async () =>
      ({
        activity: { list },
        load: async () => state,
      }) as unknown as ApiRepository,
  );
  const response = await app(
    new Request(
      `http://localhost/v1/activity?kind=project&id=${id}&path=activity`,
      { headers: { Authorization: "Bearer fixture" } },
    ),
  );
  expect(response.status).toBe(200);
  expect(list).toHaveBeenCalledExactlyOnceWith({ kind: "project", id });
});

test("log deletion passes the original source identity to the scoped SQL RPC", async () => {
  const rpc = vi.fn(async () => ({ data: null, error: null as any })),
    repo = activityRepository({ rpc } as unknown as SupabaseClient);
  const id = crypto.randomUUID(),
    targetId = crypto.randomUUID();
  await repo.remove({ id, kind: "task", targetId });
  expect(rpc).toHaveBeenCalledWith("planner_delete_log", {
    entry_id: id,
    entity_kind: "task",
    entity_id: targetId,
  });
  rpc.mockResolvedValueOnce({ data: null, error: { code: "PT404" } });
  await expect(
    repo.remove({ id, kind: "task", targetId }),
  ).rejects.toMatchObject({ status: 404 });
});
