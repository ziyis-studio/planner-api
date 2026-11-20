import { expect, test } from "vitest";
import { applyCommand } from "../src/domain/commands";
import { emptyWorkspace } from "../src/domain/model";
import { parseCommand } from "../src/command-schema";
import { parseWorkspace } from "../src/domain/validation";
import { mealDay } from "../src/meals";
import {
  recoveryPatch,
  restorePatch,
  parseBackup,
  copyBackup,
} from "../src/domain/recovery";
import { createApi } from "../src/app";
const input = {
  kind: "lunch" as const,
  ateAt: "2026-11-18T16:15:00Z",
  timeZone: "Asia/Kuala_Lumpur",
  description: "Rice and vegetables",
};
test("meal nutrition preserves missing versus zero, date boundaries and partial totals", () => {
  let state = emptyWorkspace();
  for (const nutrition of [
    { calories: 0, protein: 0 },
    { calories: 300.25, protein: 12.5 },
    { carbs: 8.1 },
  ])
    state = applyCommand(state, {
      type: "meal.save",
      input: { ...input, ...nutrition },
    }).snapshot;
  const day = mealDay(state, { date: "2026-11-19", zone: input.timeZone });
  expect(day.meals).toHaveLength(3);
  expect(day.totals.calories).toEqual({ amount: 300.25, recorded: 2 });
  expect(day.totals.protein).toEqual({ amount: 12.5, recorded: 2 });
  expect(day.totals.fat).toEqual({ amount: null, recorded: 0 });
  expect(day.history.at(-1)).toMatchObject({
    calories: 300.25,
    recorded: 2,
    meals: 3,
  });
  expect(
    mealDay(state, { date: "2026-11-18", zone: input.timeZone }).meals,
  ).toHaveLength(0);
  expect(
    mealDay(state, { date: "2026-11-18", zone: "UTC" }).meals,
  ).toHaveLength(3);
});
test("photo-only records, strict validation, stale revisions and recovery round trips", async () => {
  const photo = {
    ref: `planner-image://${crypto.randomUUID()}.jpg`,
    alt: "Lunch",
  };
  const result = applyCommand(emptyWorkspace(), {
    type: "meal.save",
    input: { ...input, description: "", photos: [photo] },
  });
  const meal = result.snapshot.meals[0];
  for (const change of [
    { calories: -1 },
    { protein: Infinity },
    { fat: 1.001 },
    { photos: [{ ref: "https://public.invalid/photo.jpg", alt: "bad" }] },
    { photos: [photo, photo] },
  ])
    expect(() =>
      parseCommand({ type: "meal.save", input: { ...input, ...change } }),
    ).toThrow();
  expect(() =>
    applyCommand(result.snapshot, {
      type: "meal.save",
      id: meal.id,
      expectedUpdatedAt: "stale",
      input,
    }),
  ).toThrow(/changed elsewhere/);
  expect(() =>
    applyCommand(result.snapshot, { type: "meal.save", id: meal.id, input }),
  ).toThrow(/Reload/);
  expect(() =>
    applyCommand(result.snapshot, {
      type: "meal.save",
      input: { ...input, ateAt: "2099-01-01T00:00:00Z" },
    }),
  ).toThrow(/past or present/);
  const after = applyCommand(result.snapshot, {
    type: "meal.delete",
    id: meal.id,
    expectedUpdatedAt: meal.updatedAt,
  }).snapshot;
  expect(
    restorePatch(after, recoveryPatch(result.snapshot, after)).meals,
  ).toEqual([meal]);
  const backup = parseBackup({
    app: "ONE",
    version: 2,
    id: crypto.randomUUID(),
    ownerId: "demo",
    exportedAt: new Date().toISOString(),
    workspace: result.snapshot,
    sessions: [],
    trash: [],
  });
  const copied = await copyBackup(backup, "another-owner", true);
  expect(copied.backup.workspace.meals[0].id).not.toBe(meal.id);
  expect(copied.backup.workspace.meals[0].photos).toEqual([photo]);
  const legacy = { ...emptyWorkspace() } as Record<string, unknown>;
  delete legacy.meals;
  expect(parseWorkspace(legacy).meals).toEqual([]);
});
test("the API authenticates meal access and the stateless sample uses the same server calculations", async () => {
  const state = applyCommand(emptyWorkspace(), {
    type: "meal.save",
    input: { ...input, calories: 400 },
  }).snapshot;
  const app = createApi(async (token) => {
    expect(token).toBe("owner");
    return {
      load: async () => state,
      execute: async (command) => applyCommand(state, command),
    };
  });
  expect(
    (
      await app(
        new Request(
          "http://api/v1/meals?date=2026-11-19&zone=Asia%2FKuala_Lumpur",
        ),
      )
    ).status,
  ).toBe(401);
  const response = await app(
    new Request(
      "http://api/v1/meals?date=2026-11-19&zone=Asia%2FKuala_Lumpur",
      { headers: { authorization: "Bearer owner" } },
    ),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).data.totals.calories.amount).toBe(400);
  const sample = await app(
    new Request("http://api/v1/sample/meals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: state,
        query: { date: "2026-11-19", zone: input.timeZone },
      }),
    }),
  );
  expect(sample.status).toBe(200);
  expect((await sample.json()).data.meals).toHaveLength(1);
});
