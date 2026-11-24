import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { beforeAll, afterAll, test, expect } from "vitest";
import { sessionBatch } from "../src/sessions";
import { sessionSchema } from "../src/domain/recovery";
const db = new PGlite({ extensions: { btree_gist } });
const owner = crypto.randomUUID(),
  other = crypto.randomUUID(),
  project = crypto.randomUUID(),
  log = crypto.randomUUID();
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
  await db.query(
    "insert into public.projects(owner_id,id,title) values($1,$2,'Project')",
    [owner, project],
  );
  await db.query(
    "select public.planner_append_log($1,'project',$2,'Testing')",
    [log, project],
  );
}, 30000);
afterAll(() => db.close());
test("log deletion requires both owner and source target, preserves other entries, and stays deleted from feeds and backups", async () => {
  const keep = crypto.randomUUID();
  await db.query("select public.planner_append_log($1,'project',$2,'Keep')", [
    keep,
    project,
  ]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    other,
  ]);
  await expect(
    db.query("select public.planner_delete_log($1,'project',$2)", [
      log,
      project,
    ]),
  ).rejects.toThrow();
  expect(
    (
      await db.query(
        "delete from public.entity_logs where id=$1 returning id",
        [log],
      )
    ).rows,
  ).toEqual([]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    owner,
  ]);
  await expect(
    db.query("select public.planner_delete_log($1,'task',$2)", [log, project]),
  ).rejects.toThrow();
  await db.query("select public.planner_delete_log($1,'project',$2)", [
    log,
    project,
  ]);
  const feed = (
    await db.query<any>(
      "select id from public.planner_activity_log('project',$1)",
      [project],
    )
  ).rows;
  expect(feed.map((r) => r.id)).toEqual([keep]);
  const backup = (
    await db.query<any>(
      "select public.planner_export_backup_with_recurrences() as data",
    )
  ).rows[0].data;
  expect(backup.activity.map((r: any) => r.id)).toEqual([keep]);
});
test("custom focus lengths pass API, SQL, recorded blocks and backup validation, while invalid lengths and shorter elapsed times fail", async () => {
  for (const minutes of [1, 45, 180]) {
    const id = crypto.randomUUID(),
      end = Date.now() - 1000,
      start = end - minutes * 60000;
    expect(
      sessionBatch.parse({
        timezone: "Asia/Kuala_Lumpur",
        records: [
          {
            id,
            mode: "focus",
            startedAt: start,
            completedAt: end,
            durationSeconds: minutes * 60,
          },
        ],
      }).records[0].durationSeconds,
    ).toBe(minutes * 60);
    await db.query(
      "insert into public.pomodoro_sessions(owner_id,id,mode,started_at,completed_at,duration_seconds,timezone) values($1,$2,'focus',$3,$4,$5,'Asia/Kuala_Lumpur')",
      [
        owner,
        id,
        new Date(start).toISOString(),
        new Date(end).toISOString(),
        minutes * 60,
      ],
    );
    const row = (
      await db.query<any>(
        "select time_block_id from public.pomodoro_sessions where id=$1",
        [id],
      )
    ).rows[0];
    const block = (
      await db.query<any>(
        "select description from public.time_blocks where id=$1",
        [row.time_block_id],
      )
    ).rows[0];
    expect(block.description).toContain(`Focus time: ${minutes} min`);
  }
  for (const seconds of [0, 61, 59, 10860])
    await expect(
      db.query(
        "insert into public.pomodoro_sessions(owner_id,id,mode,started_at,completed_at,duration_seconds) values($1,$2,'focus',now()-interval '4 hours',now(),$3)",
        [owner, crypto.randomUUID(), seconds],
      ),
    ).rejects.toThrow();
  await expect(
    db.query(
      "insert into public.pomodoro_sessions(owner_id,id,mode,started_at,completed_at,duration_seconds) values($1,$2,'focus',now()-interval '30 minutes',now(),2700)",
      [owner, crypto.randomUUID()],
    ),
  ).rejects.toThrow();
  await expect(
    db.query(
      "insert into public.pomodoro_sessions(owner_id,id,mode,started_at,completed_at,duration_seconds) values($1,$2,'short',now()-interval '30 minutes',now(),600)",
      [owner, crypto.randomUUID()],
    ),
  ).rejects.toThrow();
  const backup = (
    await db.query<any>(
      "select public.planner_export_backup_with_recurrences() as data",
    )
  ).rows[0].data;
  for (const session of backup.sessions)
    expect(sessionSchema.parse(session).duration_seconds).toBe(
      session.duration_seconds,
    );
});
