import type { Workspace } from "./domain/model.js";
import { parseWorkspace } from "./domain/validation.js";

export const tables = [
  ["tagCatalog", "tag_catalog", ["id"]],
  ["projects", "projects", ["id"]],
  ["tasks", "tasks", ["id"]],
  ["conditions", "task_completion_conditions", ["id"]],
  ["thoughts", "thoughts", ["id"]],
  ["habits", "habits", ["id"]],
  ["occurrences", "habit_occurrences", ["id"]],
  ["executions", "habit_executions", ["id"]],
  ["timeBlocks", "time_blocks", ["id"]],
  ["notes", "notes", ["id"]],
  ["noteDatabases", "note_databases", ["id"]],
  ["databaseRecords", "database_records", ["id"]],
  ["sleepRecords", "sleep_records", ["id"]],
  ["meals", "meals", ["id"]],
  ["noteLinks", "note_links", ["id"]],
  ["thoughtTaskLinks", "thought_task_links", ["thought_id", "task_id"]],
  [
    "thoughtProjectLinks",
    "thought_project_links",
    ["thought_id", "project_id"],
  ],
  ["blockTaskLinks", "time_block_tasks", ["time_block_id", "task_id"]],
  [
    "blockOccurrenceLinks",
    "time_block_habit_occurrences",
    ["time_block_id", "occurrence_id"],
  ],
] as const;
const snake = (key: string) =>
  key === "timeZone"
    ? "timezone"
    : key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (key: string) =>
  key === "timezone"
    ? "timeZone"
    : key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export type CloudRow = Record<string, unknown>;
export function toCloud(row: object): CloudRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [snake(key), value]),
  );
}
export function fromCloud(value: unknown): Workspace {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The cloud returned an invalid workspace.");
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = { schemaVersion: 1 };
  for (const [property, table] of tables) {
    const rows = source[table] ?? (table === "meals" ? [] : undefined);
    if (!Array.isArray(rows))
      throw new Error(`The cloud workspace response is missing ${table}.`);
    const links = property.endsWith("Links") && property !== "noteLinks";
    result[property] = rows.map((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error(`The cloud returned an invalid ${table} record.`);
      return Object.fromEntries(
        Object.entries(row)
          .filter(
            ([key]) =>
              key !== "owner_id" &&
              (!links || !["created_at", "updated_at"].includes(key)),
          )
          .map(([key, value]) => [
            camel(key),
            // The exact server revision is opaque: Date would discard Postgres microseconds.
            key.endsWith("_at") &&
            key !== "updated_at" &&
            typeof value === "string"
              ? new Date(value).toISOString()
              : value,
          ]),
      );
    });
  }
  const state = parseWorkspace(result);
  for (const rows of [state.tasks, state.projects])
    rows.sort(
      (a, b) =>
        (a.listPosition ?? 0) - (b.listPosition ?? 0) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  return state;
}
export interface CloudChange {
  table: string;
  action: "insert" | "update" | "delete";
  row: CloudRow;
  expectedUpdatedAt?: string;
}
export function changesBetween(
  before: Workspace,
  after: Workspace,
): CloudChange[] {
  const changes: CloudChange[] = [];
  const projectDeletes: CloudChange[] = [];
  // Child-first deletion preserves FK restrictions; parent-first writes allow atomic creates.
  for (const [property, table, keys] of [...tables].reverse()) {
    const next = new Set(
      after[property].map((row) =>
        JSON.stringify(keys.map((key) => toCloud(row)[key])),
      ),
    );
    for (const row of before[property]) {
      const cloud = toCloud(row);
      if (!next.has(JSON.stringify(keys.map((key) => cloud[key]))))
        (table === "projects" || table === "notes"
          ? projectDeletes
          : changes
        ).push({
          table,
          action: "delete",
          row: Object.fromEntries(keys.map((key) => [key, cloud[key]])),
          ...("updatedAt" in row ? { expectedUpdatedAt: row.updatedAt } : {}),
        });
    }
  }
  for (const [property, table, keys] of tables) {
    const previous = new Map(
      before[property].map((row) => [
        JSON.stringify(keys.map((key) => toCloud(row)[key])),
        row,
      ]),
    );
    for (const row of after[property]) {
      const cloud = toCloud(row);
      // Recorded provenance is set by the completion/recovery transaction only.
      if (table === "time_blocks") {
        delete cloud.recorded_type;
        delete cloud.source_session_id;
      }
      const old = previous.get(JSON.stringify(keys.map((key) => cloud[key])));
      if (!old) changes.push({ table, action: "insert", row: cloud });
      else if (JSON.stringify(old) !== JSON.stringify(row))
        changes.push({
          table,
          action: "update",
          row: cloud,
          ...("updatedAt" in old ? { expectedUpdatedAt: old.updatedAt } : {}),
        });
    }
  }
  // Detach surviving Tasks before removing their Project, within the same RPC transaction.
  return [...changes, ...projectDeletes];
}
