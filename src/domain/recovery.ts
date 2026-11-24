import { validSessionDuration } from "./session-duration.js";
import { activitySchema } from "./activity.js";
import type { ActivityLog } from "./activity.js";
import type { Workspace } from "./model.js";
import { PlannerError } from "./model.js";
import { parseWorkspace } from "./validation.js";
import { z } from "zod";
export const collections = [
  "tagCatalog",
  "projects",
  "taskRecurrences",
  "tasks",
  "conditions",
  "thoughts",
  "notes",
  "noteDatabases",
  "databaseRecords",
  "sleepRecords",
  "meals",
  "noteLinks",
  "habits",
  "occurrences",
  "executions",
  "timeBlocks",
  "thoughtTaskLinks",
  "thoughtProjectLinks",
  "blockTaskLinks",
  "blockOccurrenceLinks",
] as const;
type Collection = (typeof collections)[number];
type Row = Record<string, unknown>;
const rows = (state: Workspace, key: Collection) =>
  state[key] as unknown as Row[];
export const rowKey = (row: Row) =>
  typeof row.id === "string"
    ? row.id
    : JSON.stringify(
        Object.keys(row)
          .filter((k) => k.endsWith("Id"))
          .sort()
          .map((k) => [k, row[k]]),
      );
const stable = (v: unknown): string =>
  JSON.stringify(
    v && typeof v === "object"
      ? Array.isArray(v)
        ? v.map((x) => JSON.parse(stable(x)))
        : Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, JSON.parse(stable(x))]),
          )
      : (v ?? null),
  );
const field = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][A-Za-z0-9]*$/)
      .refine(
        (k) =>
          ![
            "__proto__",
            "constructor",
            "prototype",
            "id",
            "createdAt",
            "updatedAt",
          ].includes(k),
      ),
    hadBefore: z.boolean(),
    hadAfter: z.boolean(),
    before: z.unknown(),
    after: z.unknown(),
  })
  .strict();
export const recoveryPatchSchema = z
  .object({
    removed: z
      .record(z.string(), z.array(z.record(z.string(), z.unknown())).max(10000))
      .refine((v) =>
        Object.keys(v).every((k) =>
          (collections as readonly string[]).includes(k),
        ),
      ),
    changed: z
      .array(
        z
          .object({
            collection: z.enum(collections),
            key: z.string().max(1000),
            fields: z.array(field).max(100),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type RecoveryPatch = z.infer<typeof recoveryPatchSchema>;
export type RecoveryEntry = {
  id: string;
  kind: string;
  title: string;
  deletedAt: string;
  restoredAt: string | null;
  patch?: RecoveryPatch;
};
export function recoveryPatch(
  before: Workspace,
  after: Workspace,
): RecoveryPatch {
  const removed: RecoveryPatch["removed"] = {},
    changed: RecoveryPatch["changed"] = [];
  for (const name of collections) {
    const newer = new Map(rows(after, name).map((r) => [rowKey(r), r]));
    for (const old of rows(before, name)) {
      const next = newer.get(rowKey(old));
      if (!next) {
        (removed[name] ??= []).push(old);
        continue;
      }
      const fields: (typeof changed)[number]["fields"] = [];
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (["id", "createdAt", "updatedAt"].includes(key)) continue;
        if (
          stable(old[key]) !== stable(next[key]) ||
          Object.hasOwn(old, key) !== Object.hasOwn(next, key)
        )
          fields.push({
            key,
            hadBefore: Object.hasOwn(old, key),
            hadAfter: Object.hasOwn(next, key),
            before: old[key] ?? null,
            after: next[key] ?? null,
          });
      }
      if (fields.length)
        changed.push({ collection: name, key: rowKey(old), fields });
    }
  }
  return { removed, changed };
}
export function restorePatch(current: Workspace, raw: unknown): Workspace {
  const patch = recoveryPatchSchema.parse(raw),
    next = structuredClone(current);
  for (const [name, items] of Object.entries(patch.removed)) {
    const target = rows(next, name as Collection);
    for (const row of items) {
      if (target.some((r) => rowKey(r) === rowKey(row)))
        throw new PlannerError(
          "conflict",
          "An item with this identity already exists. Current data was kept.",
        );
      target.push(row);
    }
  }
  for (const edit of patch.changed) {
    const row = rows(next, edit.collection).find((r) => rowKey(r) === edit.key);
    if (!row)
      throw new PlannerError(
        "conflict",
        "A related item is missing. Restore its parent first.",
      );
    for (const f of edit.fields) {
      if (
        Object.hasOwn(row, f.key) !== f.hadAfter ||
        stable(row[f.key]) !== stable(f.after)
      )
        throw new PlannerError(
          "conflict",
          "Related data changed after deletion. Restore was cancelled to keep your edits.",
        );
      if (f.hadBefore) row[f.key] = f.before;
      else delete row[f.key];
    }
  }
  return parseWorkspace(next);
}
export function mergeWorkspace(
  current: Workspace,
  incoming: Workspace,
): Workspace {
  const next = structuredClone(current);
  for (const name of collections) {
    const target = rows(next, name),
      known = new Set(target.map(rowKey));
    for (const row of rows(incoming, name))
      if (!known.has(rowKey(row))) {
        target.push(row);
        known.add(rowKey(row));
      }
  }
  return parseWorkspace(next);
}
export const sessionSchema = z
  .object({
    id: z.uuid(),
    mode: z.enum(["focus", "short", "long"]),
    started_at: z.iso.datetime({ offset: true }),
    completed_at: z.iso.datetime({ offset: true }),
    duration_seconds: z.number().int(),
    timezone: z.string().max(100).default("Asia/Kuala_Lumpur"),
    time_block_id: z.uuid().nullable().optional(),
    task_id: z.uuid().nullable().optional(),
    task_snapshot_id: z.uuid().nullable().optional(),
    task_title: z.string().max(300).default(""),
  })
  .strict()
  .refine(
    (r) =>
      validSessionDuration(r.mode, r.duration_seconds) &&
      Date.parse(r.completed_at) - Date.parse(r.started_at) >=
        r.duration_seconds * 1000,
    "Invalid focus duration",
  );
export type Backup = {
  app: "ONE";
  version: 2;
  id: string;
  ownerId: string;
  exportedAt: string;
  workspace: Workspace;
  sessions: z.infer<typeof sessionSchema>[];
  trash: RecoveryEntry[];
  activity?: ActivityLog[];
};
export function parseBackup(raw: unknown): Backup {
  const base = z
    .object({
      app: z.literal("ONE"),
      version: z.literal(2).optional(),
      id: z.uuid().optional(),
      ownerId: z.string().max(100).optional(),
      exportedAt: z.string().optional(),
      workspace: z.unknown(),
      activity: z.array(activitySchema).max(20000).default([]),
      sessions: z.array(sessionSchema).max(20000).default([]),
      trash: z
        .array(
          z
            .object({
              id: z.uuid(),
              kind: z.string().max(80),
              title: z.string().max(500),
              deletedAt: z.string(),
              restoredAt: z.string().nullable(),
              patch: recoveryPatchSchema,
            })
            .strict(),
        )
        .max(1000)
        .default([]),
    })
    .passthrough()
    .parse(raw);
  return {
    sessions: base.sessions,
    activity: base.activity,
    trash: base.trash,
    app: "ONE",
    version: 2,
    id: base.id ?? "00000000-0000-4000-8000-000000000000",
    ownerId: base.ownerId ?? "",
    exportedAt: base.exportedAt ?? new Date().toISOString(),
    workspace: parseWorkspace(base.workspace),
  };
}
export async function backupCopyId(
  owner: string,
  backupId: string,
  id: string,
) {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(owner + ":" + backupId + ":" + id),
    ),
  );
  hash[6] = (hash[6] & 15) | 64;
  hash[8] = (hash[8] & 63) | 128;
  const h = [...hash.slice(0, 16)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export async function copyBackup(
  source: Backup,
  owner: string,
  copy: boolean,
): Promise<{ backup: Backup; idMap: Record<string, string> }> {
  if (!copy && (!source.ownerId || source.ownerId === owner))
    return { backup: source, idMap: {} };
  const ids = new Set<string>();
  const references = new Set([
    "id",
    "projectId",
    "taskId",
    "recurrenceId",
    "habitId",
    "occurrenceId",
    "noteId",
    "targetNoteId",
    "thoughtId",
    "databaseId",
    "timeBlockId",
    "sourceSessionId",
    "target_id",
    "task_id",
    "task_snapshot_id",
    "time_block_id",
  ]);
  function collect(v: unknown) {
    if (Array.isArray(v)) {
      v.forEach(collect);
      return;
    }
    if (v && typeof v === "object")
      for (const [key, x] of Object.entries(v)) {
        if (
          references.has(key) &&
          typeof x === "string" &&
          /^[0-9a-f-]{36}$/i.test(x)
        )
          ids.add(x);
        else if (key !== "values") collect(x);
      }
  }
  collect(source);
  ids.delete(source.id);
  const map: Record<string, string> = {};
  for (const id of ids) {
    map[id] = await backupCopyId(owner, source.id, id);
  }
  function remap(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(remap);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          references.has(k) && typeof x === "string"
            ? (map[x] ?? x)
            : k === "values" && x && typeof x === "object"
              ? Object.fromEntries(
                  Object.entries(x).map(([id, value]) => [
                    map[id] ?? id,
                    value,
                  ]),
                )
              : remap(x),
        ]),
      );
    return v;
  }
  const backup = remap(source) as Backup;
  backup.id = source.id;
  backup.ownerId = owner;
  // Recovery identities are recomputed from their restored row when copied.
  for (let i = 0; i < backup.trash.length; i++)
    for (let j = 0; j < (backup.trash[i].patch?.changed.length ?? 0); j++) {
      const e = backup.trash[i].patch!.changed[j];
      for (const f of e.fields) {
        if (f.key === "values") {
          for (const side of ["before", "after"] as const) {
            const v = f[side];
            if (v && typeof v === "object" && !Array.isArray(v))
              f[side] = Object.fromEntries(
                Object.entries(v).map(([id, value]) => [map[id] ?? id, value]),
              );
          }
        }
        if (references.has(f.key)) {
          if (typeof f.before === "string")
            f.before = map[f.before] ?? f.before;
          if (typeof f.after === "string") f.after = map[f.after] ?? f.after;
        }
      }
      try {
        const identity = JSON.parse(e.key);
        if (Array.isArray(identity))
          e.key = JSON.stringify(
            identity.map(([k, v]: [string, string]) => [k, map[v] ?? v]),
          );
        else e.key = map[e.key] ?? e.key;
      } catch {
        e.key = map[e.key] ?? e.key;
      }
    }
  return { backup, idMap: map };
}
