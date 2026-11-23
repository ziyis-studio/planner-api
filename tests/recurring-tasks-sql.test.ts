import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { beforeAll, afterAll, expect, test } from "vitest";
import { fromCloud, changesBetween } from "../src/cloud-mapping";
import { applyCommand } from "../src/domain/commands";
import { recoveryPatch, restorePatch } from "../src/domain/recovery";
import type { Command } from "../src/domain/commands";
const db = new PGlite({ extensions: { btree_gist } });
const owner = crypto.randomUUID(),
  other = crypto.randomUUID();
beforeAll(async () => {
  await db.exec(
    `create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create schema extensions;create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`,
  );
  const root = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(root)).sort())
    if (!file.includes("image_uploads"))
      await db.exec(await readFile(new URL(file, root), "utf8"));
  await db.query("insert into auth.users(id) values($1),($2)", [owner, other]);
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    owner,
  ]);
}, 30000);
afterAll(() => db.close());
async function load() {
  return fromCloud(
    (
      await db.query<{ data: unknown }>(
        "select public.planner_load_workspace_with_recurrences() as data",
      )
    ).rows[0].data,
  );
}
async function run(command: Command) {
  const before = await load(),
    result = applyCommand(before, command);
  await db.query("select public.planner_apply_changes($1::jsonb)", [
    JSON.stringify(changesBetween(before, result.snapshot)),
  ]);
  return { before, result };
}
test("SQL saves series, per-date tasks, conditions and blocks atomically; duplicate dates and cross-owner links are rejected", async () => {
  await run({
    type: "task.create",
    input: {
      title: "还网费",
      conditions: ["Paid"],
      recurrence: {
        frequency: "monthly",
        interval: 1,
        startsOn: "2026-11-24",
        endsOn: null,
        monthDay: "last",
        time: "09:00",
        duration: 30,
        timeZone: "Asia/Kuala_Lumpur",
      },
    },
  });
  let state = await load();
  expect(state.taskRecurrences).toHaveLength(1);
  expect(state.tasks).toHaveLength(2);
  expect(state.timeBlocks).toHaveLength(2);
  expect(state.conditions).toHaveLength(2);
  const first = state.tasks[0],
    series = state.taskRecurrences[0];
  await expect(
    db.query(
      "insert into public.tasks(owner_id,title,recurrence_id,scheduled_on) values($1,'Duplicate',$2,$3)",
      [owner, series.id, first.scheduledOn],
    ),
  ).rejects.toThrow();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    other,
  ]);
  expect((await load()).taskRecurrences).toEqual([]);
  await expect(
    db.query(
      "insert into public.tasks(owner_id,title,recurrence_id,scheduled_on) values($1,'Foreign series',$2,$3)",
      [other, series.id, first.scheduledOn],
    ),
  ).rejects.toThrow();
  expect(
    (
      await db.query(
        "update public.task_recurrences set active=false where id=$1 returning id",
        [series.id],
      )
    ).rows,
  ).toHaveLength(0);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    owner,
  ]);
  const legacy = (
    await db.query<any>(
      "select public.planner_load_workspace_with_meals() as data",
    )
  ).rows[0].data;
  expect(legacy.tasks[0]).not.toHaveProperty("recurrence_id");
  expect(legacy).not.toHaveProperty("task_recurrences");
  const backup = (
    await db.query<any>(
      "select public.planner_export_backup_with_recurrences() as data",
    )
  ).rows[0].data;
  expect(backup.workspace.task_recurrences[0].id).toBe(series.id);
  const before = await load(),
    after = applyCommand(before, {
      type: "task.delete",
      id: first.id,
    }).snapshot;
  const entry = crypto.randomUUID(),
    patch = recoveryPatch(before, after);
  await db.query(
    "select public.planner_apply_recoverable_changes($1::jsonb,$2::jsonb)",
    [
      JSON.stringify(changesBetween(before, after)),
      JSON.stringify({
        id: entry,
        kind: "task",
        title: first.title,
        payload: patch,
      }),
    ],
  );
  state = await load();
  expect(state.taskRecurrences[0].skippedOn).toContain(first.scheduledOn);
  await run({
    type: "tasks.materialize",
    from: "2026-11-24",
    to: "2027-03-31",
  });
  expect(
    (await load()).tasks.some((t) => t.scheduledOn === first.scheduledOn),
  ).toBe(false);
  const current = await load(),
    restored = restorePatch(current, patch);
  await db.query(
    "select public.planner_restore_recovery($1,$2::jsonb,'[]'::jsonb)",
    [entry, JSON.stringify(changesBetween(current, restored))],
  );
  expect((await load()).tasks.some((t) => t.id === first.id)).toBe(true);
  const staleBefore = await load();
  const pendingGeneration = applyCommand(staleBefore, {
    type: "tasks.materialize",
    from: "2027-04-01",
    to: "2027-05-31",
  });
  await run({
    type: "task.recurrence.stop",
    id: series.id,
    expectedUpdatedAt: staleBefore.taskRecurrences[0].updatedAt,
  });
  await expect(
    db.query("select public.planner_apply_changes($1::jsonb)", [
      JSON.stringify(changesBetween(staleBefore, pendingGeneration.snapshot)),
    ]),
  ).rejects.toThrow();
  expect((await load()).tasks.some((t) => t.scheduledOn === "2027-04-30")).toBe(
    false,
  );
  const stale = applyCommand(staleBefore, {
    type: "task.recurrence.stop",
    id: series.id,
    expectedUpdatedAt: staleBefore.taskRecurrences[0].updatedAt,
  });
  await expect(
    db.query("select public.planner_apply_changes($1::jsonb)", [
      JSON.stringify(changesBetween(staleBefore, stale.snapshot)),
    ]),
  ).rejects.toThrow();
});
