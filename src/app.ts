import { parseCommand } from "./command-schema.js";
import { z } from "zod";
import type { ApiRepository } from "./repository.js";
import { ApiError } from "./repository.js";
import { PlannerError } from "./domain/model.js";
import type { NoteTarget } from "./domain/model.js";
import type { Command } from "./domain/commands.js";
import {
  databaseFieldsSchema,
  databaseValuesSchema,
  databaseRecordView,
} from "./domain/note-databases.js";
const title = z.string().trim().min(1).max(300);
const noteSchema = z
  .object({
    title,
    content: z.string().max(500_000).default(""),
    tags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  })
  .strict();
const databaseSchema = z
  .object({
    title,
    description: z.string().max(10000).default(""),
    noteId: z.uuid().nullable().default(null),
    fields: databaseFieldsSchema.default([]),
  })
  .strict();
const recordSchema = z
  .object({
    title,
    content: z.string().max(500_000).default(""),
    values: databaseValuesSchema.default({}),
    databaseRevision: z.string().min(1).max(100),
  })
  .strict();
const querySchema = z.object({
  q: z.string().max(200).default(""),
  sort: z.string().max(100).default("title"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  field: z.string().max(100).default(""),
  filter: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
async function body(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new ApiError(415, "content_type", "Use application/json.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_json", "JSON body required.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1_048_576) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large", "Maximum body size is 1 MiB.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body.");
  }
}
export function createApi(
  authenticate: (token: string) => Promise<ApiRepository>,
  allowedOrigins: string[] = [],
) {
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": crypto.randomUUID(),
      Vary: "Origin",
    });
    const json = (data: unknown, status = 200) => {
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify(data), { status, headers });
    };
    try {
      const origin = request.headers.get("origin");
      if (origin && !allowedOrigins.includes(origin))
        throw new ApiError(403, "origin_denied", "Origin not allowed.");
      if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Expose-Headers", "ETag, X-Request-Id");
      }
      if (request.method === "OPTIONS") {
        headers.set(
          "Access-Control-Allow-Methods",
          "GET, POST, PATCH, DELETE, OPTIONS",
        );
        headers.set(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, If-Match",
        );
        return new Response(null, { status: 204, headers });
      }
      const url = new URL(request.url),
        path = url.pathname.replace(/\/$/, "");
      if (path === "/v1/health" && request.method === "GET")
        return json({ status: "ok", version: 1 });
      const authRepo = async () => {
        const token = /^Bearer (\S+)$/i.exec(
          request.headers.get("authorization") ?? "",
        )?.[1];
        if (!token)
          throw new ApiError(
            401,
            "unauthorized",
            "Bearer access token required.",
          );
        return authenticate(token);
      };
      if (path === "/v1/workspace") {
        if (request.method !== "GET")
          throw new ApiError(405, "method_not_allowed", "Use GET.");
        return json({ data: await (await authRepo()).load() });
      }
      if (path === "/v1/commands") {
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        const repo = await authRepo();
        const command = parseCommand(await body(request));
        return json({ data: await repo.execute(command) });
      }
      const resources = {
        tasks: "tasks",
        projects: "projects",
        conditions: "conditions",
        thoughts: "thoughts",
        habits: "habits",
        occurrences: "occurrences",
        executions: "executions",
        schedule: "timeBlocks",
        sleep: "sleepRecords",
        tags: "tagCatalog",
      } as const;
      const resourceMatch =
        /^\/v1\/(tasks|projects|conditions|thoughts|habits|occurrences|executions|schedule|sleep|tags)(?:\/([^/]+))?$/.exec(
          path,
        );
      if (resourceMatch) {
        if (request.method !== "GET")
          throw new ApiError(
            405,
            "method_not_allowed",
            "Use POST /v1/commands for mutations.",
          );
        const state = await (await authRepo()).load();
        const rows =
          state[resources[resourceMatch[1] as keyof typeof resources]];
        if (resourceMatch[2]) {
          const id = z.uuid().parse(resourceMatch[2]);
          const item = rows.find((r) => r.id === id);
          if (!item) throw new ApiError(404, "not_found", "Item not found.");
          return json({ data: item });
        }
        const q = querySchema.parse(Object.fromEntries(url.searchParams));
        const filtered = rows.filter((r) =>
          JSON.stringify(r).toLowerCase().includes(q.q.toLowerCase()),
        );
        return json({
          data: filtered.slice(q.offset, q.offset + q.limit),
          meta: { total: filtered.length, limit: q.limit, offset: q.offset },
        });
      }
      if (path === "/v1/profile") {
        const repo = await authRepo();
        if (!repo.profile)
          throw new ApiError(503, "unavailable", "Profile unavailable.");
        if (request.method === "GET")
          return json({ data: { username: await repo.profile.load() } });
        if (request.method === "PATCH") {
          const { username } = z
            .strictObject({
              username: z
                .string()
                .trim()
                .toLowerCase()
                .regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/),
            })
            .parse(await body(request));
          return json({
            data: { username: await repo.profile.save(username) },
          });
        }
        throw new ApiError(405, "method_not_allowed", "Use GET or PATCH.");
      }
      if (path === "/v1/images" || path.startsWith("/v1/images/")) {
        const repo = await authRepo();
        if (!repo.images)
          throw new ApiError(503, "unavailable", "Images unavailable.");
        if (request.method === "GET" && path.startsWith("/v1/images/")) {
          const blob = await repo.images.get(
            `planner-image://${path.slice("/v1/images/".length)}`,
          );
          headers.set("Content-Type", blob.type);
          return new Response(blob, { headers });
        }
        if (request.method === "POST" && path === "/v1/images") {
          const reader = request.body?.getReader();
          if (!reader)
            throw new ApiError(400, "invalid_image", "Image required.");
          let size = 0;
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 5 * 1024 * 1024) {
              await reader.cancel();
              throw new ApiError(
                413,
                "body_too_large",
                "Image limit is 5 MiB.",
              );
            }
            chunks.push(value);
          }
          const blob = new Blob([Buffer.concat(chunks)], {
            type: request.headers.get("content-type") ?? "",
          });
          return json({ data: { ref: await repo.images.upload(blob) } }, 201);
        }
        throw new ApiError(405, "method_not_allowed", "Method not allowed.");
      }
      const match =
        /^\/v1\/(notes|databases|records)(?:\/([^/]+))?(?:\/(records|databases))?$/.exec(
          path,
        );
      if (!match) throw new ApiError(404, "not_found", "Endpoint not found.");
      const [, resource, id, child] = match;
      if (id) z.uuid().parse(id);
      if (
        child &&
        !(
          (resource === "notes" && child === "databases") ||
          (resource === "databases" && child === "records")
        )
      )
        throw new ApiError(404, "not_found", "Endpoint not found.");
      const token = /^Bearer (\S+)$/i.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (!token)
        throw new ApiError(
          401,
          "unauthorized",
          "Bearer access token required.",
        );
      const repo = await authenticate(token),
        state = await repo.load();
      const collection =
        resource === "notes"
          ? state.notes
          : resource === "databases"
            ? state.noteDatabases
            : state.databaseRecords;
      const current = id
        ? collection.find((item) => item.id === id)
        : undefined;
      if (id && !current)
        throw new ApiError(404, "not_found", "Item not found.");
      const kind = child ?? resource;
      const selected =
        child === "records"
          ? state.databaseRecords.filter((r) => r.databaseId === id)
          : child === "databases"
            ? state.noteDatabases.filter((d) => d.noteId === id)
            : collection;
      if (request.method === "GET") {
        if (id && !child) {
          headers.set("ETag", JSON.stringify(current!.updatedAt));
          return json({ data: current });
        }
        const q = querySchema.parse(Object.fromEntries(url.searchParams));
        let rows: Array<(typeof selected)[number]>;
        if (kind === "records")
          rows = databaseRecordView(
            selected as typeof state.databaseRecords,
            q.q,
            q.sort,
            q.direction,
            q.field,
            q.filter,
          );
        else {
          if (!["title", "updatedAt"].includes(q.sort))
            throw new ApiError(
              422,
              "invalid",
              "Sort must be title or updatedAt.",
            );
          rows = selected
            .filter((r) =>
              JSON.stringify(r).toLowerCase().includes(q.q.toLowerCase()),
            )
            .sort(
              (a, b) =>
                (q.sort === "title"
                  ? a.title.localeCompare(b.title)
                  : a.updatedAt.localeCompare(b.updatedAt)) *
                (q.direction === "asc" ? 1 : -1),
            );
        }
        return json({
          data: rows.slice(q.offset, q.offset + q.limit),
          meta: { total: rows.length, limit: q.limit, offset: q.offset },
        });
      }
      const method = request.method;
      if (
        !["POST", "PATCH", "DELETE"].includes(method) ||
        (method === "POST" && id && child !== "records") ||
        (method !== "POST" && (!id || child)) ||
        (method === "POST" && resource === "records")
      )
        throw new ApiError(405, "method_not_allowed", "Method not allowed.");
      let revision: string | undefined;
      if (method !== "POST") {
        const raw = request.headers.get("if-match");
        if (!raw)
          throw new ApiError(
            428,
            "revision_required",
            "Send the latest ETag in If-Match.",
          );
        revision =
          raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
        if (revision !== current!.updatedAt)
          throw new ApiError(
            412,
            "revision_conflict",
            "Item changed. Reload before retrying.",
          );
      }
      let command: Command;
      if (method === "DELETE")
        command =
          resource === "notes"
            ? { type: "note.delete", id: id!, expectedUpdatedAt: revision }
            : resource === "databases"
              ? {
                  type: "database.delete",
                  id: id!,
                  expectedUpdatedAt: revision!,
                }
              : {
                  type: "database.record.delete",
                  id: id!,
                  expectedUpdatedAt: revision!,
                };
      else {
        const raw = await body(request);
        const editing = method === "PATCH";
        if (kind === "notes") {
          const parsed = (editing ? noteSchema.partial() : noteSchema).parse(
            raw,
          );
          const patch = editing
            ? Object.fromEntries(
                Object.entries(parsed).filter(([key]) =>
                  Object.hasOwn(raw as object, key),
                ),
              )
            : parsed;
          const base = editing
            ? state.notes.find((n) => n.id === id)
            : undefined;
          const input = noteSchema.parse({
            title: base?.title,
            content: base?.content,
            tags: base?.tags,
            ...patch,
          });
          // Only editable fields are sent to the command; existing graph connections remain intact.
          const targets: NoteTarget[] = state.noteLinks
            .filter((l) => l.noteId === id)
            .flatMap<NoteTarget>((l) =>
              l.targetNoteId
                ? [{ kind: "note" as const, id: l.targetNoteId }]
                : l.taskId
                  ? [{ kind: "task" as const, id: l.taskId }]
                  : l.projectId
                    ? [{ kind: "project" as const, id: l.projectId }]
                    : l.thoughtId
                      ? [{ kind: "thought" as const, id: l.thoughtId }]
                      : [],
            );
          command = {
            type: "note.save",
            id: editing ? id : undefined,
            expectedUpdatedAt: revision,
            input: { ...input, targets },
          };
        } else if (kind === "databases") {
          const parsed = (
            editing ? databaseSchema.partial() : databaseSchema
          ).parse(raw);
          const patch = editing
            ? Object.fromEntries(
                Object.entries(parsed).filter(([key]) =>
                  Object.hasOwn(raw as object, key),
                ),
              )
            : parsed;
          const base = editing
            ? state.noteDatabases.find((d) => d.id === id)
            : undefined;
          const input = databaseSchema.parse({
            title: base?.title,
            description: base?.description,
            noteId: base?.noteId,
            fields: base?.fields,
            ...patch,
          });
          command = {
            type: "database.save",
            id: editing ? id : undefined,
            expectedUpdatedAt: revision,
            input,
          };
        } else {
          const parsed = (
            editing
              ? recordSchema.partial().required({ databaseRevision: true })
              : recordSchema
          ).parse(raw);
          const patch = editing
            ? Object.fromEntries(
                Object.entries(parsed).filter(([key]) =>
                  Object.hasOwn(raw as object, key),
                ),
              )
            : parsed;
          const base = editing
            ? state.databaseRecords.find((r) => r.id === id)
            : undefined;
          const input = recordSchema.parse({
            title: base?.title,
            content: base?.content,
            values: base?.values,
            ...patch,
          });
          command = {
            type: "database.record.save",
            id: editing ? id : undefined,
            expectedUpdatedAt: revision,
            databaseRevision: input.databaseRevision,
            input: {
              title: input.title,
              content: input.content,
              values: input.values,
              databaseId: base?.databaseId ?? id!,
            },
          };
        }
      }
      const result = await repo.execute(command);
      if (method === "DELETE")
        return new Response(null, { status: 204, headers });
      const rows =
        kind === "notes"
          ? result.snapshot.notes
          : kind === "databases"
            ? result.snapshot.noteDatabases
            : result.snapshot.databaseRecords;
      const saved = rows.find((r) => r.id === (result.id ?? id));
      if (saved) headers.set("ETag", JSON.stringify(saved.updatedAt));
      return json({ data: saved }, method === "POST" ? 201 : 200);
    } catch (error) {
      if (error instanceof z.ZodError)
        return json(
          {
            error: {
              code: "invalid",
              message: "Invalid request.",
              details: error.issues.map((i) => ({
                path: i.path,
                message: i.message,
              })),
            },
          },
          422,
        );
      if (error instanceof ApiError)
        return json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      if (error instanceof PlannerError)
        return json(
          { error: { code: error.code, message: error.message } },
          error.code === "missing"
            ? 404
            : error.code === "conflict"
              ? 409
              : 422,
        );
      return json(
        {
          error: {
            code: "internal_error",
            message: "Request could not be completed.",
          },
        },
        500,
      );
    }
  };
}
