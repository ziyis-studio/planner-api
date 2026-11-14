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
