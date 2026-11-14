import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { afterAll, beforeAll, expect, test } from "vitest";
import { applyCommand } from "../src/domain/commands";
import type { Command } from "../src/domain/commands";
import { changesBetween, fromCloud } from "../src/cloud-mapping";
import { createApi } from "../src/app";
const db = new PGlite({ extensions: { btree_gist } });
const owner = "10000000-0000-4000-8000-000000000001",
  other = "10000000-0000-4000-8000-000000000002";
beforeAll(async () => {
  await db.exec(
    `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema extensions; create schema auth; create table auth.users(id uuid primary key,email text); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;`,
  );
  const root = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(root)).sort())
    if (!file.includes("image_uploads"))
      await db.exec(await readFile(new URL(file, root), "utf8"));
  await db.exec(
    `insert into auth.users(id) values ('${owner}'),('${other}');set role authenticated;select set_config('request.jwt.claim.sub','${owner}',false);`,
  );
}, 30000);
afterAll(() => db.close());
async function load() {
  const { rows } = await db.query<{ data: unknown }>(
    "select public.planner_load_workspace_with_databases() as data",
  );
  return fromCloud(rows[0].data);
}
async function run(command: Command) {
  const before = await load();
  const result = applyCommand(before, command);
  const changes = changesBetween(before, result.snapshot);
  await db.query("select public.planner_apply_changes($1::jsonb)", [
    JSON.stringify(changes),
  ]);
  return result.id!;
}
test("migration supports atomic database creation, record edits, schema cleanup and private ownership", async () => {
  const field = crypto.randomUUID();
  const id = await run({
    type: "database.save",
    input: {
      title: "Tracker",
      description: "",
      noteId: null,
      fields: [{ id: field, name: "Cost", type: "number", options: [] }],
    },
  });
  let state = await load();
  const row = await run({
    type: "database.record.save",
    databaseRevision: state.noteDatabases[0].updatedAt,
    input: {
      databaseId: id,
      title: "Desk",
      content: "Notes",
      values: { [field]: 30 },
    },
  });
  state = await load();
  expect(state.databaseRecords[0].values[field]).toBe(30);
  await expect(
    db.query(
      'update public.database_records set "values"=$1::jsonb where id=$2',
      [JSON.stringify({ [field]: "invalid" }), row],
    ),
  ).rejects.toThrow();
  await db.exec(`select set_config('request.jwt.claim.sub','${other}',false)`);
  expect((await load()).noteDatabases).toEqual([]);
  await expect(
    db.query(
      "insert into public.database_records(database_id,title) values($1,$2)",
      [id, "Other owner"],
    ),
  ).rejects.toThrow();
  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`);
  await run({
    type: "database.save",
    id,
    expectedUpdatedAt: state.noteDatabases[0].updatedAt,
    input: { ...state.noteDatabases[0], fields: [] },
  });
  expect((await load()).databaseRecords[0].values).toEqual({});
  const latest = await load();
  await expect(
    run({
      type: "database.record.save",
      id: row,
      expectedUpdatedAt: state.databaseRecords[0].updatedAt,
      databaseRevision: latest.noteDatabases[0].updatedAt,
      input: { ...latest.databaseRecords[0], title: "Stale" },
    }),
  ).rejects.toThrow("changed elsewhere");
  await run({
    type: "database.delete",
    id,
    expectedUpdatedAt: latest.noteDatabases[0].updatedAt,
  });
  expect((await load()).databaseRecords).toEqual([]);
});

test("HTTP handler persists records through the SQL API and reloads server revisions", async () => {
  const app = createApi(async () => ({
    load,
    execute: async (command) => {
      const before = await load();
      const result = applyCommand(before, command);
      const changes = JSON.stringify(changesBetween(before, result.snapshot));
      if (command.type === "database.record.save")
        await db.query(
          "select public.planner_apply_database_record_changes($1::jsonb,$2::uuid,$3::timestamptz)",
          [changes, command.input.databaseId, command.databaseRevision],
        );
      else
        await db.query("select public.planner_apply_changes($1::jsonb)", [
          changes,
        ]);
      return { id: result.id, snapshot: await load() };
    },
  }));
  const request = (path: string, body?: unknown) =>
    app(
      new Request("http://localhost/v1" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: "Bearer fixture",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const response = await request("/databases", { title: "API database" });
  expect(response.status).toBe(201);
  const { data: database } = await response.json();
  const row = await request(`/databases/${database.id}/records`, {
    title: "Stored page",
    content: "## Details",
    databaseRevision: database.updatedAt,
  });
  expect(row.status).toBe(201);
  const records = await (
    await request(`/databases/${database.id}/records`)
  ).json();
  expect(records.data[0].content).toBe("## Details");
  await expect(
    db.query(
      "select public.planner_apply_database_record_changes($1::jsonb,$2::uuid,$3::timestamptz)",
      ["[]", database.id, "2000-01-01T00:00:00Z"],
    ),
  ).rejects.toThrow("Database schema changed");
});
