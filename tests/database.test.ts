import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { beforeAll, afterAll, expect, test } from "vitest";
import { changesBetween, fromCloud } from "../src/cloud-mapping";
import { applyCommand } from "../src/domain/commands";
import type { Command } from "../src/domain/commands";
import type { Workspace } from "../src/domain/model";

const owner = "10000000-0000-4000-8000-000000000001",
  other = "10000000-0000-4000-8000-000000000002";
const db = new PGlite({ extensions: { btree_gist } });
const read = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");
async function load(): Promise<Workspace> {
  const { rows } = await db.query<{ data: Parameters<typeof fromCloud>[0] }>(
    "select public.planner_load_workspace_with_databases() as data",
  );
  return fromCloud(rows[0].data);
}
async function execute(command: Command) {
  const before = await load();
  const result = applyCommand(before, command);
  const changes = changesBetween(before, result.snapshot);
  if (changes.length)
    await db.query("select public.planner_apply_changes($1::jsonb)", [
      JSON.stringify(changes),
    ]);
  return { snapshot: await load(), id: result.id! };
}
beforeAll(async () => {
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;`);
  await db.exec("create schema extensions");
  for (const name of (
    await readdir(new URL("../supabase/migrations/", import.meta.url))
  ).sort())
    if (!name.includes("image_uploads"))
      await db.exec(await read(`supabase/migrations/${name}`));
}, 30_000);
afterAll(async () => {
  await db.close();
});

test("habit deletion removes children in FK-safe order, rejects stale/cross-owner changes atomically and retains schedules", async () => {
  const deletionOwner = "96500000-0000-4000-8000-000000000001",
    deletionOther = "96500000-0000-4000-8000-000000000002";
  await db.exec(
    `insert into auth.users(id,email) values ('${deletionOwner}','habit-delete@example.invalid'),('${deletionOther}','habit-other@example.invalid');set role authenticated;select set_config('request.jwt.claim.sub','${deletionOwner}',false);`,
  );
  try {
    const habit = (
      await execute({
        type: "habit.create",
        input: {
          title: "Delete",
          timeZone: "Asia/Kuala_Lumpur",
          startsOn: "2026-10-19",
          isoWeekdays: [1, 2, 3, 4, 5, 6, 7],
        },
      })
    ).id;
    const other = (
      await execute({
        type: "habit.create",
        input: {
          title: "Keep",
          timeZone: "Asia/Kuala_Lumpur",
          startsOn: "2026-10-19",
          isoWeekdays: [1, 2, 3, 4, 5, 6, 7],
        },
      })
    ).id;
    const task = (
      await execute({
        type: "task.create",
        input: { title: "Keep task", conditions: ["Keep condition"] },
      })
    ).id;
    await execute({
      type: "occurrences.materialize",
      from: "2026-10-19",
      to: "2026-10-20",
    });
    const generated = await load();
    const occurrence = generated.occurrences.find((o) => o.habitId === habit)!,
      retained = generated.occurrences.find((o) => o.habitId === other)!;
    await execute({
      type: "execution.record",
      occurrenceId: occurrence.id,
      performedOn: "2026-10-20",
    });
    await execute({
      type: "execution.record",
      occurrenceId: retained.id,
      performedOn: "2026-10-20",
      note: "Keep history",
    });
    await execute({
      type: "block.save",
      input: {
        title: "Shared",
        timeZone: "Asia/Kuala_Lumpur",
        startsAt: "2026-10-20T01:00:00Z",
        endsAt: "2026-10-20T02:00:00Z",
        taskIds: [task],
        occurrenceIds: [occurrence.id, retained.id],
      },
    });
    const before = await load();
    const original = before.habits.find((h) => h.id === habit)!;
    const changes = changesBetween(
      before,
      applyCommand(before, {
        type: "habit.delete",
        id: habit,
        expectedUpdatedAt: original.updatedAt,
      }).snapshot,
    );
    const deletionTables = changes.map((c) => c.table);
    expect(deletionTables.indexOf("time_block_habit_occurrences")).toBeLessThan(
      deletionTables.indexOf("habit_executions"),
    );
    expect(deletionTables.indexOf("habit_executions")).toBeLessThan(
      deletionTables.indexOf("habit_occurrences"),
    );
    expect(deletionTables.indexOf("habit_occurrences")).toBeLessThan(
      deletionTables.indexOf("habits"),
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      deletionOther,
    ]);
    await expect(
      db.query("select public.planner_apply_changes($1::jsonb)", [
        JSON.stringify(changes),
      ]),
    ).rejects.toMatchObject({ code: "PT409" });
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      deletionOwner,
    ]);
    expect(await load()).toEqual(before);
    await execute({
      type: "habit.update",
      id: habit,
      input: { ...original, title: "Newer habit" },
    });
    const newer = await load();
    // Child removals run before the stale parent check; the whole transaction must roll back.
    await expect(
      db.query("select public.planner_apply_changes($1::jsonb)", [
        JSON.stringify(changes),
      ]),
    ).rejects.toMatchObject({ code: "PT409" });
    expect(await load()).toEqual(newer);
    const result = await execute({
      type: "habit.delete",
      id: habit,
      expectedUpdatedAt: newer.habits.find((h) => h.id === habit)!.updatedAt,
    });
    expect(result.snapshot.habits.map((h) => h.id)).toEqual([other]);
    expect(result.snapshot.occurrences).toEqual(
      before.occurrences.filter((o) => o.habitId !== habit),
    );
    expect(result.snapshot.executions).toEqual(
      before.executions.filter((e) => e.habitId !== habit),
    );
    expect(result.snapshot.timeBlocks).toEqual(before.timeBlocks);
    expect(result.snapshot.blockTaskLinks).toEqual(before.blockTaskLinks);
    expect(result.snapshot.blockOccurrenceLinks).toEqual(
      before.blockOccurrenceLinks.filter(
        (link) => link.occurrenceId === retained.id,
      ),
    );
    expect(result.snapshot.tasks).toEqual(before.tasks);
    expect(result.snapshot.conditions).toEqual(before.conditions);
  } finally {
    await db.exec("reset role;");
  }
});

test("Habit start repair persists atomically and protects concurrent history and parent revisions", async () => {
  const actor = "96600000-0000-4000-8000-000000000001",
    stranger = "96600000-0000-4000-8000-000000000002";
  await db.exec(
    `insert into auth.users(id,email) values ('${actor}','habit-start@example.invalid'),('${stranger}','habit-start-other@example.invalid');set role authenticated;select set_config('request.jwt.claim.sub','${actor}',false);`,
  );
  try {
    const habit = (
      await execute({
        type: "habit.create",
        input: {
          title: "Start repair",
          timeZone: "Asia/Kuala_Lumpur",
          startsOn: "2026-10-19",
          isoWeekdays: [1, 2, 3, 4, 5, 6, 7],
        },
      })
    ).id;
    await execute({
      type: "occurrences.materialize",
      from: "2026-10-19",
      to: "2026-10-25",
    });
    const generated = await load();
    const day = (value: string) =>
      generated.occurrences.find(
        (o) => o.habitId === habit && o.scheduledOn === value,
      )!;
    await execute({
      type: "execution.record",
      occurrenceId: day("2026-10-19").id,
      performedOn: "2026-10-20",
    });
    await execute({
      type: "occurrence.reschedule",
      id: day("2026-10-20").id,
      plannedOn: "2026-10-27",
      note: "Keep plan",
    });
    await execute({
      type: "block.save",
      input: {
        title: "Keep scheduled block",
        startsAt: "2026-10-21T01:00:00Z",
        endsAt: "2026-10-21T02:00:00Z",
        timeZone: "Asia/Kuala_Lumpur",
        occurrenceIds: [day("2026-10-21").id],
      },
    });
    const before = await load();
    const input = { ...before.habits[0], startsOn: "2026-10-26" };
    const changes = changesBetween(
      before,
      applyCommand(before, {
        type: "habit.update",
        id: habit,
        input,
        expectedUpdatedAt: before.habits[0].updatedAt,
      }).snapshot,
    );
    expect(
      changes.filter(
        (c) => c.table === "habit_occurrences" && c.action === "delete",
      ),
    ).toHaveLength(4);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      stranger,
    ]);
    await expect(
      db.query("select public.planner_apply_changes($1::jsonb)", [
        JSON.stringify(changes),
      ]),
    ).rejects.toMatchObject({ code: "PT409" });
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      actor,
    ]);
    expect(await load()).toEqual(before);
    // A newly completed last child must roll back earlier placeholder removals.
    await execute({
      type: "execution.record",
      occurrenceId: day("2026-10-25").id,
      performedOn: "2026-10-25",
    });
    const newer = await load();
    await expect(
      db.query("select public.planner_apply_changes($1::jsonb)", [
        JSON.stringify(changes),
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await load()).toEqual(newer);
    const updated = (
      await execute({
        type: "habit.update",
        id: habit,
        input,
        expectedUpdatedAt: newer.habits[0].updatedAt,
      })
    ).snapshot;
    expect(updated.occurrences.map((o) => o.scheduledOn).sort()).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-25",
    ]);
    expect(updated.executions).toEqual(newer.executions);
    expect(updated.timeBlocks).toEqual(newer.timeBlocks);
    expect(updated.blockOccurrenceLinks).toEqual(newer.blockOccurrenceLinks);

    const legacy = (
      await execute({
        type: "habit.create",
        input: {
          title: "Legacy start",
          timeZone: "Asia/Kuala_Lumpur",
          startsOn: "2026-10-25",
          isoWeekdays: [1, 2, 3, 4, 5, 6, 7],
        },
      })
    ).id;
    await execute({
      type: "occurrences.materialize",
      from: "2026-10-25",
      to: "2026-10-25",
    });
    // Simulate a date saved by the earlier app, which retained its old placeholder.
    await db.query(
      "update public.habits set starts_on='2026-10-26' where id=$1::uuid",
      [legacy],
    );
    const legacyBefore = await load();
    const repair = changesBetween(
      legacyBefore,
      applyCommand(legacyBefore, {
        type: "occurrences.materialize",
        from: "2026-10-25",
        to: "2026-11-01",
      }).snapshot,
    );
    expect(
      repair.some(
        (c) =>
          c.table === "habits" &&
          c.row.id === legacy &&
          c.expectedUpdatedAt ===
            legacyBefore.habits.find((h) => h.id === legacy)?.updatedAt,
      ),
    ).toBe(true);
    await db.query(
      "update public.habits set starts_on='2026-10-25' where id=$1::uuid",
      [legacy],
    );
    const changedStart = await load();
    await expect(
      db.query("select public.planner_apply_changes($1::jsonb)", [
        JSON.stringify(repair),
      ]),
    ).rejects.toMatchObject({ code: "PT409" });
    expect(await load()).toEqual(changedStart);
    // Repair succeeds on fresh state and remains stable on the next materialization.
    await db.query(
      "update public.habits set starts_on='2026-10-26' where id=$1::uuid",
      [legacy],
    );
    const repaired = (
      await execute({
        type: "occurrences.materialize",
        from: "2026-10-25",
        to: "2026-11-01",
      })
    ).snapshot;
    expect(
      repaired.occurrences.filter((o) => o.habitId === legacy),
    ).toHaveLength(7);
    expect(
      repaired.occurrences
        .filter((o) => o.habitId === legacy)
        .every((o) => o.scheduledOn >= "2026-10-26"),
    ).toBe(true);
    expect(
      (
        await execute({
          type: "occurrences.materialize",
          from: "2026-10-25",
          to: "2026-11-01",
        })
      ).snapshot,
    ).toEqual(repaired);
  } finally {
    await db.exec("reset role;");
  }
});

test("List ordering persists atomically with completion/revision/ownership gates intact", async () => {
  try {
    const result = await db.exec(
      await read("database/verify-list-ordering.sql"),
    );
    expect(result.at(-1)?.rows[0]).toMatchObject({ passed_checks: 12 });
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
});

test("Project task and condition reorder commands round trip through the cloud mapping and invoker API", async () => {
  await db.exec(
    `insert into auth.users(id,email) values ('96400000-0000-4000-8000-000000000001','order-roundtrip@example.invalid');set role authenticated;select set_config('request.jwt.claim.sub','96400000-0000-4000-8000-000000000001',false);`,
  );
  try {
    const project = await execute({
      type: "project.create",
      input: { title: "Order" },
    });
    const a = await execute({
      type: "task.create",
      input: {
        title: "First",
        projectId: project.id,
        conditions: ["One", "Two"],
      },
    });
    const b = await execute({
      type: "task.create",
      input: { title: "Second", projectId: project.id },
    });
    const reordered = await execute({
      type: "project.reorderTasks",
      projectId: project.id,
      items: b.snapshot.tasks
        .filter((t) => t.projectId === project.id)
        .sort((a, b) => b.projectPosition! - a.projectPosition!),
    });
    expect(
      reordered.snapshot.tasks.find((t) => t.id === b.id)?.projectPosition,
    ).toBe(0);
    const conditions = await execute({
      type: "task.reorderConditions",
      taskId: a.id,
      items: reordered.snapshot.conditions
        .filter((c) => c.taskId === a.id)
        .sort((a, b) => b.position - a.position),
    });
    expect(
      conditions.snapshot.conditions.find((c) => c.description === "Two")
        ?.position,
    ).toBe(0);
    expect(conditions.snapshot.tasks.every((t) => !t.completedAt)).toBe(true);
  } finally {
    await db.exec("reset role;");
  }
});

test("Project icons retain completion, reject invalid/stale writes and remain owner-scoped", async () => {
  try {
    const result = await db.exec(
      await read("database/verify-project-icons.sql"),
    );
    expect(result.at(-1)?.rows[0]).toMatchObject({ passed_checks: 9 });
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
});

test("Notes ownership, links, revisions and anonymous denial pass rollback-only checks", async () => {
  const result = await db.exec(await read("database/verify-notes.sql"));
  expect(result.at(-1)?.rows[0]).toMatchObject({ passed_checks: 16 });
});
test("Notes content and all association types persist through the invoker API", async () => {
  await db.exec(
    `insert into auth.users(id,email) values ('94000000-0000-4000-8000-000000000001','notes-roundtrip@example.invalid');set role authenticated;select set_config('request.jwt.claim.sub','94000000-0000-4000-8000-000000000001',false);`,
  );
  const task = await execute({
    type: "task.create",
    input: { title: "Note task" },
  });
  const project = await execute({
    type: "project.create",
    input: { title: "Note project" },
  });
  const thought = await execute({
    type: "thought.create",
    input: { content: "Note thought" },
  });
  const first = await execute({
    type: "note.save",
    input: { title: "Source", content: "# Source", targets: [] },
  });
  const second = await execute({
    type: "note.save",
    input: {
      title: "Connected",
      content: "**Retained**",
      targets: [
        { kind: "note", id: first.id },
        { kind: "task", id: task.id },
        { kind: "project", id: project.id },
        { kind: "thought", id: thought.id },
      ],
    },
  });
  expect(second.snapshot.noteLinks).toHaveLength(4);
  expect(second.snapshot.notes.find((n) => n.id === second.id)?.content).toBe(
    "**Retained**",
  );
  const deleted = await execute({ type: "note.delete", id: second.id });
  expect(deleted.snapshot.noteLinks).toHaveLength(0);
  expect(deleted.snapshot.tasks[0].completedAt).toBeNull();
  await db.exec("reset role;");
});
test("all 127 baseline SQL assertions still pass after adding the invoker API", async () => {
  const result = await db.exec(await read("database/verify-baseline.sql"));
  expect(result.at(-1)?.rows[0]).toMatchObject({ passed_checks: 127 });
});
test("the rollback-only API verification also passes unchanged on isolated Postgres", async () => {
  const result = await db.exec(await read("database/verify-api.sql"));
  expect(result.at(-1)?.rows[0]).toMatchObject({ passed_checks: 10 });
});

test("username ownership, uniqueness, private mapping and login limits hold in Postgres", async () => {
  const result = await db.exec(await read("database/verify-usernames.sql"));
  expect(result.at(-1)?.rows[0]).toMatchObject({ passed_checks: 14 });
});
test("cloud transaction round-trip preserves manual gates, many-to-many links, history and rollback", async () => {
  await db.exec(
    `insert into auth.users values('${owner}','owner@example.invalid'),('${other}','other@example.invalid'); set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false);`,
  );
  const project = await execute({
    type: "project.create",
    input: { title: "Real project" },
  });
  const thought = await execute({
    type: "thought.create",
    input: {
      emotion: "Calm",
      content: "Keep the original.",
      recordedAt: "2026-10-21T02:35:00Z",
    },
  });
  const task = await execute({
    type: "task.create",
    input: {
      title: "A linked task",
      projectId: project.id,
      conditions: ["Deliver result"],
      sourceThoughtIds: [thought.id],
    },
  });
  expect(task.snapshot.thoughtTaskLinks).toHaveLength(1);
  // PGlite's JS timestamps can have millisecond precision. Force a real Postgres revision
  // so this round trip catches accidental Date conversion before the next write.
  await db.exec(
    "reset role; alter table public.tasks disable trigger preserve_identity_and_touch;",
  );
  await db.query(
    "update public.tasks set updated_at='2026-10-21T01:23:45.123456Z' where id=$1",
    [task.id],
  );
  await db.exec(
    "alter table public.tasks enable trigger preserve_identity_and_touch; set role authenticated;",
  );
  const preciseTask = (await load()).tasks.find((item) => item.id === task.id)!;
  expect(preciseTask.updatedAt).toContain(".123456");
  const preciseEdit = changesBetween(
    await load(),
    applyCommand(await load(), {
      type: "task.update",
      id: task.id,
      patch: { description: "Edited with a microsecond revision" },
    }).snapshot,
  );
  expect(preciseEdit[0].expectedUpdatedAt).toBe(preciseTask.updatedAt);
  await db.query("select public.planner_apply_changes($1::jsonb)", [
    JSON.stringify(preciseEdit),
  ]);
  expect(
    (await load()).tasks.find((item) => item.id === task.id)?.description,
  ).toBe("Edited with a microsecond revision");
  const conditionId = task.snapshot.conditions[0].id;
  await execute({
    type: "condition.update",
    id: conditionId,
    patch: { isMet: true },
  });
  expect((await load()).tasks[0].completedAt).toBeNull();
  await execute({ type: "task.complete", id: task.id });
  await execute({ type: "project.complete", id: project.id });
  const reopened = await execute({
    type: "condition.update",
    id: conditionId,
    patch: { isMet: false },
  });
  expect(reopened.snapshot.tasks[0].completedAt).toBeNull();
  expect(reopened.snapshot.projects[0].completedAt).toBeNull();
  const convert = await execute({
    type: "thought.convert",
    thoughtIds: [thought.id],
    kind: "project",
    input: { title: "From thought" },
  });
  expect(convert.snapshot.thoughts[0].emotion).toBe("Calm");
  expect(convert.snapshot.thoughts[0].createdAt).toBe(
    "2026-10-21T02:35:00.000Z",
  );
  await execute({
    type: "habit.create",
    input: {
      title: "Read",
      timeZone: "Asia/Kuala_Lumpur",
      startsOn: "2026-10-19",
      isoWeekdays: [1, 3, 5],
    },
  });
  const generated = await execute({
    type: "occurrences.materialize",
    from: "2026-10-19",
    to: "2026-10-23",
  });
  const occurrence = generated.snapshot.occurrences[0];
  const block = await execute({
    type: "block.save",
    input: {
      title: "",
      startsAt: "2026-10-21T01:00:00Z",
      endsAt: "2026-10-21T01:30:00Z",
      timeZone: "Asia/Kuala_Lumpur",
      taskIds: [task.id],
      occurrenceIds: [occurrence.id],
    },
  });
  expect(block.snapshot.blockTaskLinks).toHaveLength(1);
  expect(block.snapshot.blockOccurrenceLinks).toHaveLength(1);
  const beforeBad = await load();
  const changes = changesBetween(
    beforeBad,
    applyCommand(beforeBad, {
      type: "task.create",
      input: { title: "Must roll back" },
    }).snapshot,
  );
  changes.push({
    table: "time_block_tasks",
    action: "insert",
    row: { time_block_id: block.id, task_id: crypto.randomUUID() },
  });
  await expect(
    db.query("select public.planner_apply_changes($1::jsonb)", [
      JSON.stringify(changes),
    ]),
  ).rejects.toThrow();
  expect(await load()).toEqual(beforeBad);
  await execute({
    type: "occurrence.reschedule",
    id: occurrence.id,
    plannedOn: "2026-10-24",
  });
  const executed = await execute({
    type: "execution.record",
    occurrenceId: occurrence.id,
    performedOn: "2026-10-25",
  });
  expect(
    executed.snapshot.occurrences.find((o) => o.id === occurrence.id)
      ?.scheduledOn,
  ).toBe(occurrence.scheduledOn);
  expect(executed.snapshot.executions[0].performedOn).toBe("2026-10-25");
  // A client with a stale revision cannot overwrite a more recent change.
  const stale = changesBetween(
    executed.snapshot,
    applyCommand(executed.snapshot, {
      type: "task.update",
      id: task.id,
      patch: { title: "Stale overwrite" },
    }).snapshot,
  );
  await execute({
    type: "task.update",
    id: task.id,
    patch: { title: "Fresh title" },
  });
  await expect(
    db.query("select public.planner_apply_changes($1::jsonb)", [
      JSON.stringify(stale),
    ]),
  ).rejects.toMatchObject({
    code: "PT409",
    message: "Record changed or is unavailable",
  });
  expect((await load()).tasks[0].title).toBe("Fresh title");
  // No owner field can be injected and another account sees no records.
  await expect(
    db.query("select public.planner_apply_changes($1::jsonb)", [
      JSON.stringify([
        { ...stale[0], row: { ...stale[0].row, owner_id: other } },
      ]),
    ]),
  ).rejects.toThrow("Unsupported fields");
  await db.exec(`select set_config('request.jwt.claim.sub','${other}',false);`);
  expect((await load()).tasks).toHaveLength(0);
  await expect(
    db.query("select public.planner_apply_changes($1::jsonb)", [
      JSON.stringify(stale),
    ]),
  ).rejects.toThrow("Record changed");
  await db.exec("reset role; set role anon;");
  await expect(
    db.exec("select public.planner_load_workspace()"),
  ).rejects.toThrow("permission denied");
  await expect(
    db.query("select public.planner_apply_changes($1::jsonb)", ["[]"]),
  ).rejects.toThrow("permission denied");
  await db.exec("reset role;");
}, 20_000);

test("global ordering survives the new RPC while old workspace and backup shapes remain compatible", async () => {
  const user = "96500000-0000-4000-8000-000000000051";
  await db.exec(
    `reset role;insert into auth.users(id,email) values ('${user}','ordering@example.invalid');set role authenticated;select set_config('request.jwt.claim.sub','${user}',false);`,
  );
  const a = (await execute({ type: "project.create", input: { title: "A" } }))
    .id;
  const b = (await execute({ type: "project.create", input: { title: "B" } }))
    .id;
  const current = await load();
  await execute({
    type: "project.reorder",
    items: [b, a].map((id) => {
      const item = current.projects.find((p) => p.id === id)!;
      return { id, updatedAt: item.updatedAt };
    }),
  });
  const ordered = (
    await db.query<{ data: any }>(
      "select public.planner_load_workspace_with_ordering() as data",
    )
  ).rows[0].data;
  expect(ordered.projects.map((p: any) => p.id)).toEqual([b, a]);
  const legacy = (
    await db.query<{ data: any }>(
      "select public.planner_load_workspace_with_databases() as data",
    )
  ).rows[0].data;
  expect(legacy.projects.every((p: any) => !("list_position" in p))).toBe(true);
  const backup = (
    await db.query<{ data: any }>(
      "select public.planner_export_backup_with_ordering() as data",
    )
  ).rows[0].data;
  expect(backup.workspace.projects[0].id).toBe(b);
  await db.exec("reset role");
});
