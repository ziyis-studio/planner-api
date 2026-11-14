import { expect, test } from "vitest";
import { applyCommand } from "../src/domain/commands";
import type { Command } from "../src/domain/commands";
import { emptyWorkspace } from "../src/domain/model";
import { parseWorkspace } from "../src/domain/validation";
import { databaseRecordView } from "../src/domain/note-databases";
import { changesBetween } from "../src/cloud-mapping";
const field = "10000000-0000-4000-8000-000000000099";
function fixture() {
  let state = emptyWorkspace(),
    n = 0;
  const run = (command: Command) => {
    const result = applyCommand(state, command, {
      id: () => `10000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      now: () => new Date(Date.UTC(2026, 10, 14, 0, 0, n++)).toISOString(),
    });
    parseWorkspace(result.snapshot);
    state = result.snapshot;
    return result.id!;
  };
  return {
    run,
    get state() {
      return state;
    },
  };
}
test("databases persist typed records and reject stale edits or invalid values", () => {
  const f = fixture();
  const id = f.run({
    type: "database.save",
    input: {
      title: "Purchases",
      description: "",
      noteId: null,
      fields: [{ id: field, name: "Price", type: "number", options: [] }],
    },
  });
  const revision = f.state.noteDatabases[0].updatedAt;
  const row = f.run({
    type: "database.record.save",
    databaseRevision: revision,
    input: {
      databaseId: id,
      title: "Desk",
      content: "# Details",
      values: { [field]: 125 },
    },
  });
  expect(f.state.databaseRecords[0].content).toBe("# Details");
  expect(() =>
    f.run({
      type: "database.record.save",
      id: row,
      expectedUpdatedAt: "2020-01-01T00:00:00Z",
      databaseRevision: revision,
      input: { databaseId: id, title: "Desk", content: "", values: {} },
    }),
  ).toThrow("changed elsewhere");
  expect(() =>
    f.run({
      type: "database.record.save",
      databaseRevision: revision,
      input: {
        databaseId: id,
        title: "Bad",
        content: "",
        values: { [field]: "abc" },
      },
    }),
  ).toThrow("Invalid value");
  f.run({
    type: "database.save",
    id,
    expectedUpdatedAt: revision,
    input: { ...f.state.noteDatabases[0], fields: [] },
  });
  expect(f.state.databaseRecords[0].values).toEqual({});
  expect(() =>
    f.run({
      type: "database.record.save",
      databaseRevision: revision,
      input: { databaseId: id, title: "Old", content: "", values: {} },
    }),
  ).toThrow("changed elsewhere");
});
test("deleting a parent note retains its database and deleting a database removes only its records", () => {
  const f = fixture();
  const note = f.run({
    type: "note.save",
    input: { title: "Notes", content: "Keep", targets: [] },
  });
  const id = f.run({
    type: "database.save",
    input: { title: "DB", description: "", fields: [], noteId: note },
  });
  const before = f.state;
  f.run({ type: "note.delete", id: note });
  expect(f.state.noteDatabases[0].noteId).toBeNull();
  const changes = changesBetween(before, f.state);
  expect(changes[0].table).toBe("note_databases");
  expect(changes.at(-1)?.table).toBe("notes");
  f.run({
    type: "database.record.save",
    databaseRevision: f.state.noteDatabases[0].updatedAt,
    input: { databaseId: id, title: "Row", content: "Body", values: {} },
  });
  f.run({
    type: "database.delete",
    id,
    expectedUpdatedAt: f.state.noteDatabases[0].updatedAt,
  });
  expect(f.state.databaseRecords).toEqual([]);
  const old = { ...emptyWorkspace() } as Record<string, unknown>;
  delete old.noteDatabases;
  delete old.databaseRecords;
  expect(parseWorkspace(old).noteDatabases).toEqual([]);
});
test("database sorting compares numbers numerically and filters matching values", () => {
  const base = { databaseId: "d", content: "", createdAt: "", updatedAt: "" };
  const rows = [
    { ...base, id: "a", title: "A", values: { [field]: 100 } },
    { ...base, id: "b", title: "B", values: { [field]: 2 } },
  ];
  expect(databaseRecordView(rows, "", field, "asc").map((r) => r.id)).toEqual([
    "b",
    "a",
  ]);
  expect(
    databaseRecordView(rows, "", "title", "asc", field, "100").map((r) => r.id),
  ).toEqual(["a"]);
});
