import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { httpHandler } from "../src/http";
import { createApi } from "../src/app";
import { emptyWorkspace } from "../src/domain/model";
import { applyCommand } from "../src/domain/commands";
test("standalone and Vercel rewrite transports deliver validated commands and responses", async () => {
  let state = emptyWorkspace();
  const app = createApi(
    async () => ({
      load: async () => state,
      execute: async (command) => {
        const result = applyCommand(state, command);
        state = result.snapshot;
        return result;
      },
    }),
    ["https://app.example"],
  );
  const server = createServer(httpHandler(app, true));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/index?route=/v1/commands`, {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture",
        "Content-Type": "application/json",
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        type: "task.create",
        input: { title: "HTTP task", tags: [""] },
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.snapshot.tasks[0].title).toBe(
      "HTTP task",
    );
    expect((await fetch(`${base}/v1/tasks`)).status).toBe(401);
    const list = await fetch(`${base}/api/index?route=/v1/tasks&limit=1`, {
      headers: { Authorization: "Bearer fixture" },
    });
    expect((await list.json()).data).toHaveLength(1);
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("Vercel route metadata does not invalidate authenticated meal query parameters", async () => {
  const state = applyCommand(emptyWorkspace(), {
    type: "meal.save",
    input: {
      kind: "lunch",
      description: "Rice and vegetables",
      ateAt: "2026-11-19T04:00:00Z",
      timeZone: "Asia/Kuala_Lumpur",
      calories: 525,
    },
  }).snapshot;
  const app = createApi(async (token) => {
    expect(token).toBe("fixture");
    return {
      load: async () => state,
      execute: async (command) => applyCommand(state, command),
      sessions: {
        list: async (query: { day: string; zone: string }) => {
          expect(query).toEqual({
            day: "2026-11-19",
            zone: "Asia/Kuala_Lumpur",
          });
          return [];
        },
        save: async () => [],
      },
    };
  });
  const server = createServer(httpHandler(app, true));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of [
      "/v1/meals?path=meals",
      "/api/index?route=/v1/meals&path=meals",
    ]) {
      const response = await fetch(
        `${base}${path}&date=2026-11-19&zone=Asia%2FKuala_Lumpur`,
        { headers: { Authorization: "Bearer fixture" } },
      );
      expect(response.status).toBe(200);
      const value = (await response.json()).data;
      expect(value.meals).toHaveLength(1);
      expect(value.totals.calories.amount).toBe(525);
    }
    const sessions = await fetch(
      `${base}/api/index?route=/v1/sessions&path=sessions&day=2026-11-19&zone=Asia%2FKuala_Lumpur`,
      { headers: { Authorization: "Bearer fixture" } },
    );
    expect(sessions.status).toBe(200);
    expect((await sessions.json()).data).toEqual([]);
    const invalid = await fetch(
      `${base}/api/index?route=/v1/meals&path=meals&date=bad&zone=Asia%2FKuala_Lumpur`,
      { headers: { Authorization: "Bearer fixture" } },
    );
    expect(invalid.status).toBe(422);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
