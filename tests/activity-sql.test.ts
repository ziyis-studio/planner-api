import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { beforeAll, afterAll, test, expect } from "vitest";
const db = new PGlite({ extensions: { btree_gist } }),
  owner = crypto.randomUUID(),
  other = crypto.randomUUID(),
  project = crypto.randomUUID(),
  task = crypto.randomUUID(),
  parentLog = crypto.randomUUID(),
  childLog = crypto.randomUUID();
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
  await db.query("insert into public.projects(id,title) values($1,'Project')", [
    project,
  ]);
  await db.query(
    "insert into public.tasks(id,title,project_id) values($1,'Task',$2)",
    [task, project],
  );
}, 30000);
afterAll(() => db.close());
async function list(kind: string, id: string) {
  return (
    await db.query<any>("select * from public.planner_activity_log($1,$2)", [
      kind,
      id,
    ])
  ).rows;
}
test("project log rolls up child tasks, retries are idempotent and comments are immutable", async () => {
  await db.query(
    "select public.planner_append_log($1,'project',$2,' Project note ')",
    [parentLog, project],
  );
  await db.query("select public.planner_append_log($1,'task',$2,'Task note')", [
    childLog,
    task,
  ]);
  expect((await list("project", project)).map((r) => r.body).sort()).toEqual([
    "Project note",
    "Task note",
  ]);
  expect((await list("task", task)).map((r) => r.body)).toEqual(["Task note"]);
  await db.query("select public.planner_append_log($1,'task',$2,'Task note')", [
    childLog,
    task,
  ]);
  expect(await list("task", task)).toHaveLength(1);
  await expect(
    db.query("select public.planner_append_log($1,'task',$2,'Changed')", [
      childLog,
      task,
    ]),
  ).rejects.toThrow(/conflict/);
  await expect(
    db.query("update public.entity_logs set body='Changed'"),
  ).rejects.toThrow(/permission/);
});
test("deleted tasks retain comments for restore and backups import them without duplicates", async () => {
  await db.query("delete from public.tasks where id=$1", [task]);
  expect(await list("project", project)).toHaveLength(1);
  await expect(list("task", task)).rejects.toThrow(/unavailable/);
  const row = (
    await db.query<any>("select * from public.entity_logs where id=$1", [
      childLog,
    ])
  ).rows[0];
  expect(row.task_id).toBeNull();
  await db.query(
    "insert into public.tasks(id,title,project_id) values($1,'Restored',$2)",
    [task, project],
  );
  expect(await list("project", project)).toHaveLength(2);
  const backup = (
    await db.query<{ data: any }>(
      "select public.planner_export_backup() as data",
    )
  ).rows[0].data;
  expect(backup.activity).toHaveLength(2);
  await db.query(
    "select public.planner_import_backup_with_activity('[]','[]','[]','[]',$1)",
    [JSON.stringify(backup.activity)],
  );
  expect(await list("project", project)).toHaveLength(2);
});
test("owner policies block other accounts and invalid appends", async () => {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    other,
  ]);
  expect((await db.query("select * from public.entity_logs")).rows).toEqual([]);
  await expect(list("project", project)).rejects.toThrow(/unavailable/);
  await expect(
    db.query("select public.planner_append_log($1,'task',$2,'Intrusion')", [
      crypto.randomUUID(),
      task,
    ]),
  ).rejects.toThrow(/unavailable/);
  await expect(
    db.query(
      "insert into public.entity_logs(owner_id,target_kind,target_id,body) values($1,'task',$2,'Intrusion')",
      [owner, task],
    ),
  ).rejects.toThrow();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    owner,
  ]);
});
test("keyset pagination spans equal timestamps without duplicates", async () => {
  const time = "2026-11-19T01:00:00.000Z";
  for (let i = 0; i < 53; i++)
    await db.query(
      "insert into public.entity_logs(target_kind,target_id,body,created_at) values('task',$1,$2,$3)",
      [task, "Entry " + i, time],
    );
  const first = await list("task", task);
  expect(first).toHaveLength(51);
  const cursor = first[49],
    next = (
      await db.query<any>(
        "select * from public.planner_activity_log('task',$1,$2,$3)",
        [task, cursor.created_at, cursor.id],
      )
    ).rows;
  const ids = [...first.slice(0, 50), ...next].map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(54);
});
