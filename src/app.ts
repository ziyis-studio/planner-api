import { tagGraph, tagGraphQuery } from "./tag-graph.js";
import { linkedActivityBlocks, sampleActivityPage } from "./activity-feed.js";
import { mealQuery, mealDay } from "./meals.js";
import { currentWeather } from "./weather.js";
import { insightQuery, workspaceInsights } from "./insights.js";
import { pomodoroTimeBlock } from "./sample-sessions.js";
import { activitySchema } from "./domain/activity.js";
import { createDemo } from "./sample.js";
import { parseWorkspace } from "./domain/validation.js";
import { applyCommand } from "./domain/commands.js";
import {
  recoveryPatch,
  restorePatch,
  parseBackup,
  copyBackup,
  mergeWorkspace,
} from "./domain/recovery.js";
import { isTimeZone } from "./domain/time.js";
import { sessionBatch, sessionQuery } from "./sessions.js";
import { activityWriteSchema, activityQuerySchema } from "./domain/activity.js";
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
async function body(request: Request, limit = 1_048_576) {
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
    if (size > limit) {
      await reader.cancel();
      throw new ApiError(
        413,
        "body_too_large",
        `Maximum body size is ${limit === 1_048_576 ? "1 MiB" : "3.5 MB"}.`,
      );
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
  usernameLogin?: (input: {
    username: string;
    password: string;
  }) => Promise<{ status: number; data: unknown }>,
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
      if (path === "/v1/weather") {
        if (request.method !== "GET")
          throw new ApiError(405, "method_not_allowed", "Use GET.");
        const zone = z
          .string()
          .max(100)
          .refine(isTimeZone)
          .parse(url.searchParams.get("zone"));
        try {
          return json({ data: await currentWeather(zone) });
        } catch {
          throw new ApiError(
            503,
            "weather_unavailable",
            "Weather unavailable.",
          );
        }
      }
      if (path === "/v1/auth/username") {
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        if (!usernameLogin)
          throw new ApiError(503, "unavailable", "Sign in unavailable.");
        const input = z
          .strictObject({
            username: z.string().trim().min(1).max(32),
            password: z.string().min(1).max(1024),
          })
          .parse(await body(request, 4096));
        const result = await usernameLogin(input);
        return json(result.data, result.status);
      }
      // Stateless sample operations never authenticate or access a user's database.
      if (path === "/v1/sample") {
        if (request.method === "GET") {
          const zone = z
            .string()
            .refine(isTimeZone)
            .parse(url.searchParams.get("zone"));
          return json({ data: createDemo(zone) });
        }
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use GET or POST.");
        const input = z
          .strictObject({ workspace: z.unknown(), command: z.unknown() })
          .parse(await body(request, 3_500_000));
        const before = parseWorkspace(input.workspace),
          command = parseCommand(input.command);
        const result = applyCommand(before, command);
        const patch = command.type.endsWith(".delete")
          ? recoveryPatch(before, result.snapshot)
          : null;
        return json({ data: { ...result, patch } });
      }
      if (path === "/v1/sample/meals") {
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        const input = z
          .strictObject({ workspace: z.unknown(), query: mealQuery })
          .parse(await body(request, 3_500_000));
        return json({
          data: mealDay(parseWorkspace(input.workspace), input.query),
        });
      }
      if (path === "/v1/sample/tag-graph") {
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        const input = z
          .strictObject({ workspace: z.unknown(), query: tagGraphQuery })
          .parse(await body(request, 3_500_000));
        return json({
          data: tagGraph(parseWorkspace(input.workspace), input.query),
        });
      }
      if (path === "/v1/sample/insights") {
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        const input = z
          .strictObject({ workspace: z.unknown(), query: insightQuery })
          .parse(await body(request, 3_500_000));
        return json({
          data: workspaceInsights(parseWorkspace(input.workspace), input.query),
        });
      }
      if (path === "/v1/sample/sessions") {
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        const input = z
          .strictObject({
            workspace: z.unknown(),
            timezone: z.string(),
            records: z.unknown(),
          })
          .parse(await body(request, 3_500_000));
        const snapshot = parseWorkspace(input.workspace),
          batch = sessionBatch.parse({
            timezone: input.timezone,
            records: input.records,
          });
        for (const record of batch.records) {
          if (
            snapshot.timeBlocks.some(
              (b) => b.id === record.id || b.sourceSessionId === record.id,
            )
          )
            continue;
          snapshot.timeBlocks.push(pomodoroTimeBlock(record, batch.timezone));
          if (
            record.mode === "focus" &&
            record.taskId &&
            snapshot.tasks.some((t) => t.id === record.taskId)
          )
            snapshot.blockTaskLinks.push({
              timeBlockId: record.id,
              taskId: record.taskId,
            });
        }
        return json({ data: { snapshot } });
      }
      if (path === "/v1/sample/activity-feed") {
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        const input = z
          .strictObject({
            workspace: z.unknown(),
            items: z.array(activitySchema).max(20000),
            query: activityQuerySchema,
          })
          .parse(await body(request, 3_500_000));
        return json({
          data: sampleActivityPage(
            parseWorkspace(input.workspace),
            input.items,
            input.query,
          ),
        });
      }
      if (path === "/v1/sample/activity") {
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        const input = z
          .strictObject({
            workspace: z.unknown(),
            items: z.array(activitySchema).max(20000),
            entry: activityWriteSchema,
          })
          .parse(await body(request, 3_500_000));
        const workspace = parseWorkspace(input.workspace),
          entry = input.entry;
        const targets =
          entry.kind === "task" ? workspace.tasks : workspace.projects;
        if (!targets.some((t) => t.id === entry.targetId))
          throw new ApiError(404, "not_found", "Target not found.");
        const same = input.items.find((row) => row.id === entry.id);
        if (
          same &&
          (same.body !== entry.body ||
            same.target_id !== entry.targetId ||
            same.target_kind !== entry.kind)
        )
          throw new ApiError(
            409,
            "conflict",
            "This log identity already has different contents.",
          );
        return json({
          data: same || {
            id: entry.id,
            target_kind: entry.kind,
            target_id: entry.targetId,
            body: entry.body,
            created_at: new Date().toISOString(),
          },
        });
      }
      if (path === "/v1/sample/restore" || path === "/v1/sample/import") {
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        if (path.endsWith("/restore")) {
          const input = z
            .strictObject({ workspace: z.unknown(), patch: z.unknown() })
            .parse(await body(request, 3_500_000));
          // Reuse backup validation for inverse patches instead of trusting device storage.
          const shell = {
            app: "ONE",
            version: 2,
            id: crypto.randomUUID(),
            ownerId: "demo",
            exportedAt: new Date().toISOString(),
            workspace: input.workspace,
            sessions: [],
            trash: [
              {
                id: crypto.randomUUID(),
                kind: "sample",
                title: "Sample",
                deletedAt: new Date().toISOString(),
                restoredAt: null,
                patch: input.patch,
              },
            ],
          };
          const backup = parseBackup(shell);
          return json({
            data: {
              snapshot: restorePatch(backup.workspace, backup.trash[0].patch),
            },
          });
        }
        const input = z
          .strictObject({
            workspace: z.unknown(),
            backup: z.unknown(),
            asCopy: z.boolean().optional(),
          })
          .parse(await body(request, 3_500_000));
        const { backup, idMap } = await copyBackup(
          parseBackup(input.backup),
          "demo",
          input.asCopy ?? false,
        );
        const snapshot = mergeWorkspace(
          parseWorkspace(input.workspace),
          backup.workspace,
        );
        for (const record of backup.sessions) {
          if (
            !record.time_block_id ||
            snapshot.timeBlocks.some((b) => b.id === record.time_block_id)
          )
            continue;
          snapshot.timeBlocks.push({
            ...pomodoroTimeBlock(
              {
                id: record.id,
                mode: record.mode,
                startedAt: Date.parse(record.started_at),
                completedAt: Date.parse(record.completed_at),
                durationSeconds: record.duration_seconds,
                taskId: record.task_id,
                taskTitle: record.task_title,
              },
              record.timezone,
            ),
            id: record.time_block_id,
          });
          if (
            record.task_id &&
            snapshot.tasks.some((t) => t.id === record.task_id)
          )
            snapshot.blockTaskLinks.push({
              timeBlockId: record.time_block_id,
              taskId: record.task_id,
            });
        }
        return json({ data: { snapshot, backup, idMap } });
      }
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
      if (path === "/v1/tag-graph") {
        const repo = await authRepo();
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        const query = tagGraphQuery.parse(await body(request));
        return json({ data: tagGraph(await repo.load(), query) });
      }
      if (path === "/v1/insights") {
        const repo = await authRepo();
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Use POST.");
        const query = insightQuery.parse(await body(request));
        return json({ data: workspaceInsights(await repo.load(), query) });
      }
      if (path === "/v1/sessions") {
        const repo = await authRepo();
        if (!repo.sessions)
          throw new ApiError(503, "unavailable", "Focus records unavailable.");
        if (request.method === "GET")
          return json({
            data: await repo.sessions.list(
              sessionQuery.parse(Object.fromEntries(url.searchParams)),
            ),
          });
        if (request.method === "POST")
          return json({
            data: await repo.sessions.save(
              sessionBatch.parse(await body(request)),
            ),
          });
        throw new ApiError(405, "method_not_allowed", "Use GET or POST.");
      }
      if (path === "/v1/activity") {
        const repo = await authRepo();
        if (!repo.activity)
          throw new ApiError(503, "unavailable", "Log unavailable.");
        if (request.method === "GET") {
          const query = activityQuerySchema.parse(
            Object.fromEntries(url.searchParams),
          );
          const [page, state] = await Promise.all([
            repo.activity.list(query),
            repo.load(),
          ]);
          return json({
            data: { ...page, linkedBlocks: linkedActivityBlocks(state, query) },
          });
        }
        if (request.method === "POST")
          return json(
            {
              data: await repo.activity.append(
                activityWriteSchema.parse(await body(request)),
              ),
            },
            201,
          );
        throw new ApiError(405, "method_not_allowed", "Use GET or POST.");
      }
      if (path === "/v1/backup" || path.startsWith("/v1/recovery")) {
        const repo = await authRepo();
        if (!repo.recovery)
          throw new ApiError(503, "unavailable", "Recovery unavailable.");
        if (path === "/v1/backup") {
          if (request.method === "GET")
            return json({ data: await repo.recovery.backup() });
          if (request.method === "POST") {
            const input = z
              .object({ backup: z.unknown(), asCopy: z.boolean().optional() })
              .strict()
              .parse(await body(request, 3_500_000));
            return json({
              data: await repo.recovery.import(input.backup, input.asCopy),
            });
          }
        } else {
          const match =
            /^\/v1\/recovery(?:\/([0-9a-f-]{36})(\/restore)?)?$/.exec(path);
          if (!match)
            throw new ApiError(404, "not_found", "Unknown recovery entry.");
          const [, id, restore] = match;
          if (!id && request.method === "GET")
            return json({
              data: await repo.recovery.list(
                z.coerce
                  .number()
                  .int()
                  .min(0)
                  .max(100000)
                  .parse(url.searchParams.get("offset") || 0),
              ),
            });
          if (id) z.uuid().parse(id);
          if (id && restore && request.method === "POST")
            return json({ data: await repo.recovery.restore(id) });
          if (id && !restore && request.method === "DELETE") {
            await repo.recovery.purge(id);
            return json({ data: { deleted: true } });
          }
        }
        throw new ApiError(405, "method_not_allowed", "Method not allowed.");
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
      if (path === "/v1/meals") {
        const repo = await authRepo();
        if (request.method !== "GET")
          throw new ApiError(405, "method_not_allowed", "Use GET.");
        // Rewrites can append routing metadata (for example `path`). Only the
        // public meal parameters belong to this strict application schema.
        const query = mealQuery.parse({
          date: url.searchParams.get("date"),
          zone: url.searchParams.get("zone"),
        });
        return json({ data: mealDay(await repo.load(), query) });
      }
      if (/^\/v1\/(images|files)(\/|$)/.test(path)) {
        const repo = await authRepo();
        const images = path.startsWith("/v1/images");
        const store = images ? repo.images : repo.files;
        const base = images ? "/v1/images" : "/v1/files";
        const prefix = images ? "planner-image://" : "planner-file://";
        if (!store)
          throw new ApiError(503, "unavailable", "Images unavailable.");
        if (request.method === "GET" && path.startsWith(base + "/")) {
          const blob = await store.get(prefix + path.slice(base.length + 1));
          headers.set(
            "Content-Type",
            images ? blob.type : "application/octet-stream",
          );
          if (!images) headers.set("Content-Disposition", "attachment");
          return new Response(blob, { headers });
        }
        if (
          request.method === "POST" &&
          (path === base || path.startsWith(base + "/"))
        ) {
          const reader = request.body?.getReader();
          if (!reader)
            throw new ApiError(400, "invalid_image", "Image required.");
          let size = 0;
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > (images ? 5 : 3) * 1024 * 1024) {
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
          if (path !== base) {
            if (!store.restore)
              throw new ApiError(503, "unavailable", "Restore unavailable.");
            await store.restore(prefix + path.slice(base.length + 1), blob);
            return json({ data: { restored: true } });
          }
          return json({ data: { ref: await store.upload(blob) } }, 201);
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
