import { expect, test } from "vitest";
import { applyCommand } from "../src/domain/commands";
import { emptyWorkspace } from "../src/domain/model";
import { noteTargets, relatedNotes } from "../src/domain/notes";
import { parseWorkspace } from "../src/domain/validation";

test("notes retain Markdown and symmetric, deduplicated connections without completing linked work", () => {
  let s = emptyWorkspace();
  const task = applyCommand(s, {
    type: "task.create",
    input: { title: "Work" },
  });
  s = task.snapshot;
  const first = applyCommand(s, {
    type: "note.save",
    input: {
      title: "First",
      content: "# Heading\n**bold**",
      targets: [{ kind: "task", id: task.id! }],
    },
  });
  s = first.snapshot;
  const second = applyCommand(s, {
    type: "note.save",
    input: {
      title: "Second",
      content: "Text",
      targets: [
        { kind: "note", id: first.id! },
        { kind: "note", id: first.id! },
      ],
    },
  });
  s = second.snapshot;
  expect(s.noteLinks).toHaveLength(2);
  expect(relatedNotes(s, { kind: "note", id: second.id! })[0].id).toBe(
    first.id,
  );
  expect(noteTargets(s, first.id!)).toContainEqual({
    kind: "note",
    id: second.id,
  });
  expect(s.notes[0].content).toContain("**bold**");
  expect(s.tasks[0].completedAt).toBeNull();
  expect(parseWorkspace(s)).toEqual(s);
  const before = structuredClone(s);
  expect(() =>
    applyCommand(s, {
      type: "note.save",
      id: first.id,
      input: {
        title: "First",
        content: "bad",
        targets: [{ kind: "note", id: first.id! }],
      },
    }),
  ).toThrow("itself");
  expect(() =>
    applyCommand(s, {
      type: "note.save",
      id: first.id,
      expectedUpdatedAt: "old",
      input: { title: "bad", content: "", targets: [] },
    }),
  ).toThrow("changed elsewhere");
  expect(s).toEqual(before);
  s = applyCommand(s, { type: "task.delete", id: task.id! }).snapshot;
  expect(s.noteLinks).toHaveLength(1);
  s = applyCommand(s, { type: "note.delete", id: first.id! }).snapshot;
  expect(s.notes).toHaveLength(1);
  expect(s.noteLinks).toHaveLength(0);
});
test("legacy backups default to empty Notes; malformed associations are rejected", () => {
  const { notes, noteLinks, ...old } = emptyWorkspace();
  expect(parseWorkspace(old).notes).toEqual([]);
  const saved = applyCommand(emptyWorkspace(), {
    type: "note.save",
    input: { title: "Note", content: "", targets: [] },
  }).snapshot;
  expect(() =>
    parseWorkspace({
      ...saved,
      noteLinks: [
        {
          ...saved.notes[0],
          noteId: saved.notes[0].id,
          targetNoteId: null,
          taskId: null,
          projectId: null,
          thoughtId: null,
        },
      ],
    }),
  ).toThrow();
});
