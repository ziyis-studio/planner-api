import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { beforeAll, afterAll, expect, test } from "vitest";
import { fromCloud, changesBetween } from "../src/cloud-mapping";
import { applyCommand } from "../src/domain/commands";
import type { Command } from "../src/domain/commands";
import {
  recoveryPatch,
  restorePatch,
  parseBackup,
  copyBackup,
} from "../src/domain/recovery";
import { emptyWorkspace } from "../src/domain/model";
const db = new PGlite({ extensions: { btree_gist } }),
  owner = crypto.randomUUID(),
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
  const { rows } = await db.query<{ data: unknown }>(
    "select public.planner_load_workspace_with_databases() as data",
  );
  return fromCloud(rows[0].data);
}
async function run(cmd: Command) {
  const before = await load(),
    result = applyCommand(before, cmd);
  await db.query("select public.planner_apply_changes($1::jsonb)", [
    JSON.stringify(changesBetween(before, result.snapshot)),
  ]);
  return result.id!;
}
test("task completion creates actual focus, stays idempotent, and preserves task completion state", async () => {
  const task = await run({
      type: "task.create",
      input: { title: "Exam prep", description: "", projectId: null },
    }),
    session = crypto.randomUUID();
  await db.query(
    "insert into public.pomodoro_sessions(owner_id,id,mode,started_at,completed_at,duration_seconds,task_id) values($1,$2,'focus',now()-interval '30 minutes',now(),1500,$3)",
    [owner, session, task],
  );
  let state = await load();
  const block = state.timeBlocks.find((b) => b.sourceSessionId === session)!;
  expect(block.recordedType).toBe("focus");
  expect(block.title).toBe("Exam prep");
  expect(state.blockTaskLinks).toContainEqual({
    timeBlockId: block.id,
    taskId: task,
  });
  expect(state.tasks[0].completedAt).toBeNull();
  await db.query(
    "insert into public.pomodoro_sessions(owner_id,id,mode,started_at,completed_at,duration_seconds) values($1,$2,'focus',now()-interval '30 minutes',now(),1500) on conflict(owner_id,id) do nothing",
    [owner, session],
  );
  expect((await load()).timeBlocks.length).toBe(1);
  const before = await load(),
    after = applyCommand(before, { type: "task.delete", id: task }).snapshot,
    entry = crypto.randomUUID();
  await db.query(
    "select public.planner_apply_recoverable_changes($1::jsonb,$2::jsonb)",
    [
      JSON.stringify(changesBetween(before, after)),
      JSON.stringify({
        id: entry,
        kind: "task",
        title: "Exam prep",
        payload: recoveryPatch(before, after),
      }),
    ],
  );
  expect((await load()).tasks).toHaveLength(0);
  expect((await load()).timeBlocks[0].title).toBe("Exam prep");
  expect(
    (
      await db.query<any>(
        "select task_id,task_snapshot_id from public.pomodoro_sessions where id=$1",
        [session],
      )
    ).rows[0],
  ).toEqual({ task_id: null, task_snapshot_id: task });
  const current = await load(),
    restored = restorePatch(current, recoveryPatch(before, after));
  await db.query(
    "select public.planner_restore_recovery($1,$2::jsonb,$3::jsonb)",
    [
      entry,
      JSON.stringify(changesBetween(current, restored)),
      JSON.stringify(restored.timeBlocks),
    ],
  );
  expect((await load()).blockTaskLinks).toContainEqual({
    timeBlockId: block.id,
    taskId: task,
  });
  expect(
    (
      await db.query<any>(
        "select task_id from public.pomodoro_sessions where id=$1",
        [session],
      )
    ).rows[0].task_id,
  ).toBe(task);
  // An actual block can be deleted and restored without duplicating history.
  state = await load();
  const deleted = applyCommand(state, {
      type: "block.delete",
      id: block.id,
      expectedUpdatedAt: state.timeBlocks[0].updatedAt,
    }).snapshot,
    id = crypto.randomUUID();
  await db.query(
    "select public.planner_apply_recoverable_changes($1::jsonb,$2::jsonb)",
    [
      JSON.stringify(changesBetween(state, deleted)),
      JSON.stringify({
        id,
        kind: "block",
        title: block.title,
        payload: recoveryPatch(state, deleted),
      }),
    ],
  );
  const restore = restorePatch(await load(), recoveryPatch(state, deleted));
  await db.query(
    "select public.planner_restore_recovery($1,$2::jsonb,$3::jsonb)",
    [
      id,
      JSON.stringify(changesBetween(await load(), restore)),
      JSON.stringify(restore.timeBlocks),
    ],
  );
  expect((await load()).timeBlocks[0].sourceSessionId).toBe(session);
  // RLS hides recovery and records from another owner.
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    other,
  ]);
  expect((await load()).timeBlocks).toHaveLength(0);
  expect(
    (await db.query("select * from public.planner_recovery")).rows,
  ).toHaveLength(0);
  await expect(
    db.query("select public.planner_restore_recovery($1,'[]','[]')", [entry]),
  ).rejects.toThrow(/missing/);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    owner,
  ]);
});
test("portable import reuses recording blocks, rejects invalid transactions and deduplicates retries", async () => {
  const state = await load();
  const sessions = (
    await db.query<any>(
      "select id,mode,started_at::text,completed_at::text,duration_seconds,timezone,time_block_id,task_id,task_snapshot_id,task_title from public.pomodoro_sessions",
    )
  ).rows.map((r) => ({
    ...r,
    started_at: new Date(r.started_at).toISOString(),
    completed_at: new Date(r.completed_at).toISOString(),
  }));
  const exported = (
    await db.query<{ data: any }>(
      "select public.planner_export_backup() as data",
    )
  ).rows[0].data;
  expect(
    parseBackup({ ...exported, workspace: fromCloud(exported.workspace) })
      .sessions,
  ).toHaveLength(1);
  expect(exported.ownerId).toBe(owner);
  // User-edited actual times remain editable and portable.
  state.timeBlocks[0].title = "Reviewed focus";
  state.timeBlocks[0].endsAt = new Date(
    Date.parse(state.timeBlocks[0].endsAt) + 60000,
  ).toISOString();
  const source = parseBackup({
    app: "ONE",
    version: 2,
    id: crypto.randomUUID(),
    ownerId: owner,
    workspace: state,
    sessions,
    trash: [],
  });
  const { backup } = await copyBackup(source, other, false);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    other,
  ]);
  const args = [
    JSON.stringify(changesBetween(emptyWorkspace(), backup.workspace)),
    JSON.stringify(backup.sessions),
    "[]",
    JSON.stringify(backup.workspace.timeBlocks),
  ];
  await db.query(
    "select public.planner_import_backup($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb)",
    args,
  );
  expect((await load()).timeBlocks).toHaveLength(1);
  expect((await load()).timeBlocks[0].title).toBe("Reviewed focus");
  expect((await load()).timeBlocks[0].recordedType).toBe("focus");
  await db.query(
    "select public.planner_import_backup('[]',$1::jsonb,'[]',$2::jsonb)",
    [
      JSON.stringify(backup.sessions),
      JSON.stringify(backup.workspace.timeBlocks),
    ],
  );
  expect((await load()).timeBlocks).toHaveLength(1);
  const id = crypto.randomUUID();
  await expect(
    db.query(
      "select public.planner_apply_recoverable_changes($1::jsonb,$2::jsonb)",
      [
        JSON.stringify([
          {
            table: "notes",
            action: "insert",
            row: { id, title: "Must roll back", content: "" },
          },
        ]),
        JSON.stringify({
          id: crypto.randomUUID(),
          kind: "note",
          title: "Invalid",
          payload: null,
        }),
      ],
    ),
  ).rejects.toThrow();
  expect((await load()).notes).toHaveLength(0);
  await expect(
    db.query("update public.pomodoro_sessions set duration_seconds=1"),
  ).rejects.toThrow(/permission/);
});
