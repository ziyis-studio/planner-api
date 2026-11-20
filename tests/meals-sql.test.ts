import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { beforeAll, afterAll, expect, test } from "vitest";
import { fromCloud, changesBetween } from "../src/cloud-mapping";
import { applyCommand } from "../src/domain/commands";
import { recoveryPatch, restorePatch } from "../src/domain/recovery";
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
  return fromCloud(
    (
      await db.query<{ data: unknown }>(
        "select public.planner_load_workspace_with_meals() as data",
      )
    ).rows[0].data,
  );
}
test("SQL keeps meals private, includes them in backups/recovery and protects external analysis from stale writes", async () => {
  const before = await load(),
    result = applyCommand(before, {
      type: "meal.save",
      input: {
        title: "Lunch",
        kind: "lunch",
        description: "Rice",
        ateAt: "2026-11-18T04:00:00Z",
        timeZone: "Asia/Kuala_Lumpur",
        calories: 0,
        photos: [
          { ref: `planner-image://${crypto.randomUUID()}.jpg`, alt: "Rice" },
        ],
      },
    });
  await db.query("select public.planner_apply_changes($1::jsonb)", [
    JSON.stringify(changesBetween(before, result.snapshot)),
  ]);
  const initial = (await load()).meals[0];
  expect(initial.calories).toBe(0);
  expect(initial.protein).toBeNull();
  const backup = (
    await db.query<any>(
      "select public.planner_export_backup_with_meals() as data",
    )
  ).rows[0].data;
  expect(backup.workspace.meals[0].id).toBe(initial.id);
  expect(
    (
      await db.query<any>(
        "select public.planner_load_workspace_with_ordering() as data",
      )
    ).rows[0].data.meals,
  ).toBeUndefined();
  await db.query(
    "update public.meals set calories=625.5,protein=32.4,nutrition_source='external' where id=$1",
    [initial.id],
  );
  const analyzed = (await load()).meals[0];
  expect(analyzed.calories).toBe(625.5);
  expect(analyzed.nutritionSource).toBe("external");
  expect(analyzed.updatedAt).not.toBe(initial.updatedAt);
  const { id, createdAt, updatedAt, ...editable } = initial;
  const stale = applyCommand(
    { ...before, meals: [initial] },
    {
      type: "meal.save",
      id,
      expectedUpdatedAt: updatedAt,
      input: { ...editable, calories: 100 },
    },
  );
  await expect(
    db.query("select public.planner_apply_changes($1::jsonb)", [
      JSON.stringify(
        changesBetween({ ...before, meals: [initial] }, stale.snapshot),
      ),
    ]),
  ).rejects.toThrow();
  expect((await load()).meals[0].calories).toBe(625.5);
  await expect(
    db.query("update public.meals set protein=-1 where id=$1", [id]),
  ).rejects.toThrow();
  await expect(
    db.query(
      'update public.meals set photos=\'[{"ref":"https://public.invalid/p.jpg","alt":"x"}]\' where id=$1',
      [id],
    ),
  ).rejects.toThrow();
  await expect(
    db.query("update public.meals set owner_id=$1 where id=$2", [other, id]),
  ).rejects.toThrow();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    other,
  ]);
  expect((await load()).meals).toHaveLength(0);
  expect((await db.query("select * from public.meals")).rows).toHaveLength(0);
  await expect(
    db.query(
      "insert into public.meals(owner_id,title,kind,ate_at,timezone) values($1,'not yours','lunch',now(),'UTC')",
      [owner],
    ),
  ).rejects.toThrow();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    owner,
  ]);
  const existing = await load(),
    after = applyCommand(existing, {
      type: "meal.delete",
      id,
      expectedUpdatedAt: analyzed.updatedAt,
    }).snapshot,
    entry = crypto.randomUUID(),
    patch = recoveryPatch(existing, after);
  await db.query(
    "select public.planner_apply_recoverable_changes($1::jsonb,$2::jsonb)",
    [
      JSON.stringify(changesBetween(existing, after)),
      JSON.stringify({
        id: entry,
        kind: "meal",
        title: "Lunch",
        payload: patch,
      }),
    ],
  );
  expect((await load()).meals).toHaveLength(0);
  const restored = restorePatch(after, patch);
  await db.query(
    "select public.planner_restore_recovery($1,$2::jsonb,'[]'::jsonb)",
    [entry, JSON.stringify(changesBetween(after, restored))],
  );
  expect((await load()).meals[0]).toMatchObject({
    id,
    calories: 625.5,
    nutritionSource: "external",
    photos: initial.photos,
  });
  await db.exec("set role anon");
  await expect(db.query("select * from public.meals")).rejects.toThrow();
  await expect(
    db.query("select public.planner_load_workspace_with_meals()"),
  ).rejects.toThrow();
}, 30000);
