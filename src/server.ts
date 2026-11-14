import { createServer } from "node:http";
import { runtimeApi } from "./runtime";
import { httpHandler } from "./http";
const server = createServer(httpHandler(runtimeApi()));
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
const { PORT = "3001", HOST = "127.0.0.1" } = process.env;
server.listen(Number(PORT), HOST, () =>
  console.log(`Planner API listening on ${HOST}:${PORT}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
