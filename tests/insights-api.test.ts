import { expect, test, vi } from "vitest";
import { emptyWorkspace } from "../src/domain/model";
import { applyCommand } from "../src/domain/commands";
import { habitInsights, sleepInsights, insightQuery } from "../src/insights";
import { createApi } from "../src/app";

test("clock averages wrap around the full day, including noon, and do not invent an average for opposing times", () => {
  const stamp = {
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    timeZone: "UTC",
    note: "",
    awakeMinutes: 0,
  };
  const cases = [
    {
      times: [
        ["2026-11-18T03:50:00Z", "2026-11-18T11:50:00Z"],
        ["2026-11-19T04:10:00Z", "2026-11-19T12:10:00Z"],
      ],
      bedtime: "04:00",
      wakeTime: "12:00",
    },
    {
      times: [
        ["2026-11-18T11:50:00Z", "2026-11-18T19:50:00Z"],
        ["2026-11-19T12:10:00Z", "2026-11-19T20:10:00Z"],
      ],
      bedtime: "12:00",
      wakeTime: "20:00",
    },
    {
      times: [
        ["2026-11-17T23:50:00Z", "2026-11-18T07:50:00Z"],
        ["2026-11-19T00:10:00Z", "2026-11-19T08:10:00Z"],
      ],
      bedtime: "00:00",
      wakeTime: "08:00",
    },
  ];
  for (const c of cases) {
    const state = emptyWorkspace();
    state.sleepRecords = c.times.map(([startsAt, endsAt]) => ({
      ...stamp,
      id: crypto.randomUUID(),
      startsAt,
      endsAt,
    }));
    expect(
      sleepInsights(state, "2026-11-01", "2026-11-30", "2026-11-20", "UTC")
        .rhythm,
    ).toMatchObject({
      bedtime: c.bedtime,
      wakeTime: c.wakeTime,
      variation: 10,
      samples: 2,
    });
  }
  const state = emptyWorkspace();
  state.sleepRecords = [
    ["2026-11-18T00:00:00Z", "2026-11-18T08:00:00Z"],
    ["2026-11-19T12:00:00Z", "2026-11-19T20:00:00Z"],
  ].map(([startsAt, endsAt]) => ({
    ...stamp,
    id: crypto.randomUUID(),
    startsAt,
    endsAt,
  }));
  expect(
    sleepInsights(state, "2026-11-01", "2026-11-30", "2026-11-20", "UTC")
      .rhythm,
  ).toBeNull();
});

test("habit insights count planned dates, skip rest days in streaks and leave today's unfinished streak open", () => {
  let state = emptyWorkspace();
  const run = (command: Parameters<typeof applyCommand>[1]) => {
    const result = applyCommand(state, command);
    state = result.snapshot;
    return result;
  };
  const id = run({
    type: "habit.create",
    input: {
      title: "Read",
      description: "",
      startsOn: "2026-11-02",
      timeZone: "Asia/Kuala_Lumpur",
      isoWeekdays: [1, 3, 5],
    },
  }).id!;
  run({
    type: "occurrences.materialize",
    from: "2026-11-02",
    to: "2026-11-20",
  });
  for (const date of [
    "2026-11-09",
    "2026-11-11",
    "2026-11-13",
    "2026-11-16",
    "2026-11-18",
  ]) {
    const occurrence = state.occurrences.find(
      (o) => o.habitId === id && o.plannedOn === date,
    )!;
    run({
      type: "execution.record",
      occurrenceId: occurrence.id,
      performedOn: date,
    });
  }
  const before = structuredClone(state);
  const result = habitInsights(state, "2026-11-16", "2026-11-22", "2026-11-20");
  expect(result).toMatchObject({
    completed: 2,
    planned: 3,
    percentage: 67,
    perfectDays: 2,
    activeDays: 2,
    currentStreak: 5,
    bestStreak: 2,
    streakHabit: "Read",
  });
  expect(state).toEqual(before);
  expect(
    habitInsights(state, "2026-11-16", "2026-11-22", "2026-11-21")
      .currentStreak,
  ).toBe(0);
  const moved = state.occurrences.find(
    (o) => o.habitId === id && o.scheduledOn === "2026-11-18",
  )!;
  moved.plannedOn = "2026-11-19";
  const shifted = habitInsights(
    state,
    "2026-11-16",
    "2026-11-20",
    "2026-11-20",
  );
  expect(
    shifted.habits[0].days.find((d) => d.date === "2026-11-18")?.planned,
  ).toBe(0);
  expect(
    shifted.habits[0].days.find((d) => d.date === "2026-11-19"),
  ).toMatchObject({ planned: 1, completed: 1, actualDates: ["2026-11-18"] });
});

test("sleep insights use wake-up dates, sum naps, preserve awake time and average across midnight", () => {
  const state = emptyWorkspace(),
    stamp = {
      createdAt: "2026-11-19T00:00:00Z",
      updatedAt: "2026-11-19T00:00:00Z",
      timeZone: "Asia/Kuala_Lumpur",
      note: "",
    };
  state.sleepRecords = [
    {
      ...stamp,
      id: crypto.randomUUID(),
      startsAt: "2026-11-17T15:30:00Z",
      endsAt: "2026-11-17T23:30:00Z",
      awakeMinutes: 30,
    },
    {
      ...stamp,
      id: crypto.randomUUID(),
      startsAt: "2026-11-18T16:30:00Z",
      endsAt: "2026-11-19T00:30:00Z",
      awakeMinutes: 30,
    },
    {
      ...stamp,
      id: crypto.randomUUID(),
      startsAt: "2026-11-19T05:00:00Z",
      endsAt: "2026-11-19T06:00:00Z",
      awakeMinutes: 0,
    },
  ];
  const result = sleepInsights(
    state,
    "2026-11-01",
    "2026-11-30",
    "2026-11-20",
    "Asia/Kuala_Lumpur",
  );
  expect(result).toMatchObject({
    average: 480,
    loggedDays: 2,
    elapsedDays: 20,
    shortest: 450,
    longest: 510,
    rhythm: { bedtime: "00:00", wakeTime: "08:00", variation: 30, samples: 2 },
    recent: {
      date: "2026-11-19",
      minutes: 510,
      awake: 30,
      inBed: 540,
      difference: 60,
      entries: 2,
      bedtime: "00:30",
      wakeTime: "14:00",
    },
  });
  expect(result.recent?.records).toHaveLength(2);
  const empty = sleepInsights(
    state,
    "2026-12-01",
    "2026-12-31",
    "2026-11-20",
    "Asia/Kuala_Lumpur",
  );
  expect(empty).toMatchObject({
    average: null,
    loggedDays: 0,
    elapsedDays: 0,
    rhythm: null,
    recent: null,
  });
});

test("insight endpoints validate bounded ranges, isolate sample data and never execute writes", async () => {
  const execute = vi.fn(),
    load = vi.fn(async () => emptyWorkspace()),
    authenticate = vi.fn(async () => ({ load, execute }));
  const app = createApi(authenticate);
  const query = {
    kind: "habits",
    from: "2024-01-01",
    to: "2024-12-31",
    zone: "Asia/Kuala_Lumpur",
  };
  expect(insightQuery.safeParse(query).success).toBe(true);
  const call = (path: string, body: unknown, auth = true) =>
    app(
      new Request("http://localhost" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: "Bearer fixture" } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  expect((await call("/v1/insights", query, false)).status).toBe(401);
  const result = await call("/v1/insights", query);
  expect(result.status).toBe(200);
  expect((await result.json()).data.daily).toHaveLength(366);
  expect(
    (await call("/v1/insights", { ...query, to: "2025-01-02" })).status,
  ).toBe(422);
  expect(
    (await call("/v1/insights", { ...query, zone: "Invalid" })).status,
  ).toBe(422);
  authenticate.mockClear();
  load.mockClear();
  expect(
    (
      await call(
        "/v1/sample/insights",
        { workspace: emptyWorkspace(), query },
        false,
      )
    ).status,
  ).toBe(200);
  expect(authenticate).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
