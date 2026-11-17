import { expect, test } from "vitest";
import { emptyWorkspace } from "../src/domain/model";
import { applyCommand } from "../src/domain/commands";
import {
  recoveryPatch,
  restorePatch,
  parseBackup,
  copyBackup,
  mergeWorkspace,
} from "../src/domain/recovery";
const entity = () => ({
  id: crypto.randomUUID(),
  createdAt: "2026-11-17T01:00:00.000Z",
  updatedAt: "2026-11-17T01:00:00.000Z",
});
function fixture() {
  const state = emptyWorkspace();
  const p = {
    ...entity(),
    title: "Project",
    description: "",
    completedAt: null,
  };
  const t = {
    ...entity(),
    title: "Task",
    description: "",
    projectId: p.id,
    completedAt: null,
    deadline: null,
    startedAt: null,
  };
  state.projects.push(p);
  state.tasks.push(t);
  state.conditions.push({
    ...entity(),
    taskId: t.id,
    description: "Check",
    isMet: false,
    position: 0,
  });
  const block = {
    ...entity(),
    title: "Plan",
    description: "",
    startsAt: "2026-11-17T02:00:00.000Z",
    endsAt: "2026-11-17T03:00:00.000Z",
    timeZone: "Asia/Kuala_Lumpur",
  };
  state.timeBlocks.push(block);
  state.blockTaskLinks.push({ timeBlockId: block.id, taskId: t.id });
  return { state, p, t, block };
}
test("restores a deleted task with conditions and links without replacing unrelated edits", () => {
  const { state, t } = fixture();
  const after = applyCommand(state, { type: "task.delete", id: t.id }).snapshot;
  const patch = recoveryPatch(state, after);
  const current = structuredClone(after);
  current.projects[0].title = "Later edit";
  const restored = restorePatch(current, patch);
  expect(restored.tasks[0]).toEqual(t);
  expect(restored.conditions).toEqual(state.conditions);
  expect(restored.blockTaskLinks).toEqual(state.blockTaskLinks);
  expect(restored.projects[0].title).toBe("Later edit");
  expect(() => restorePatch(restored, patch)).toThrow(/identity/);
});
test("restores project detachment only while the related field still matches", () => {
  const { state, p, t } = fixture();
  const after = applyCommand(state, {
    type: "project.delete",
    id: p.id,
  }).snapshot;
  const patch = recoveryPatch(state, after);
  after.tasks[0].description = "Later description";
  const restored = restorePatch(after, patch);
  expect(restored.tasks[0].projectId).toBe(p.id);
  expect(restored.tasks[0].description).toBe("Later description");
  const second = { ...p, id: crypto.randomUUID() };
  after.projects.push(second);
  after.tasks[0].projectId = second.id;
  expect(() => restorePatch(after, patch)).toThrow(/changed/);
  expect(after.projects).toEqual([second]);
  expect(after.tasks[0].id).toBe(t.id);
});
test("portable copies remap references, database property keys and recovery patches deterministically", async () => {
  const { state, p } = fixture();
  const field = crypto.randomUUID(),
    db = {
      ...entity(),
      title: "Data",
      description: "",
      noteId: null,
      fields: [
        { id: field, name: "Cost", type: "number" as const, options: [] },
      ],
    };
  state.noteDatabases.push(db);
  state.databaseRecords.push({
    ...entity(),
    databaseId: db.id,
    title: "Desk",
    content: "",
    values: { [field]: 42 },
  });
  const after = applyCommand(state, {
    type: "project.delete",
    id: p.id,
  }).snapshot;
  const raw = {
    app: "ONE",
    version: 2,
    id: crypto.randomUUID(),
    ownerId: "source",
    exportedAt: new Date().toISOString(),
    workspace: after,
    sessions: [],
    trash: [
      {
        id: crypto.randomUUID(),
        kind: "project",
        title: p.title,
        deletedAt: new Date().toISOString(),
        restoredAt: null,
        patch: recoveryPatch(state, after),
      },
    ],
  };
  const parsed = parseBackup(raw);
  const { backup, idMap } = await copyBackup(parsed, "target", false);
  expect(backup.workspace.databaseRecords[0].values[idMap[field]]).toBe(42);
  expect(
    restorePatch(backup.workspace, backup.trash[0].patch).tasks[0].projectId,
  ).toBe(idMap[p.id]);
  expect((await copyBackup(parsed, "target", true)).idMap).toEqual(idMap);
  expect(mergeWorkspace(backup.workspace, backup.workspace)).toEqual(
    backup.workspace,
  );
  expect(parsed.workspace).toEqual(after);
});
test("legacy exports validate their entire relation graph before importing", () => {
  const { state, t } = fixture();
  expect(parseBackup({ app: "ONE", workspace: state }).version).toBe(2);
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  expect(() => parseBackup({ app: "ONE", workspace: state })).toThrow();
});
