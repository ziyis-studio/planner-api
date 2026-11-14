import type { NoteTarget, Workspace } from "./model";

export const targetKey = (target: NoteTarget) => `${target.kind}:${target.id}`;
export function noteTargets(state: Workspace, noteId: string): NoteTarget[] {
  return state.noteLinks.flatMap((l): NoteTarget[] => {
    if (l.targetNoteId === noteId) return [{ kind: "note", id: l.noteId }];
    if (l.noteId !== noteId) return [];
    if (l.targetNoteId) return [{ kind: "note", id: l.targetNoteId }];
    if (l.taskId) return [{ kind: "task", id: l.taskId }];
    if (l.projectId) return [{ kind: "project", id: l.projectId }];
    if (l.thoughtId) return [{ kind: "thought", id: l.thoughtId }];
    return [];
  });
}
export function targetTitle(state: Workspace, target: NoteTarget) {
  const items = {
    note: state.notes,
    task: state.tasks,
    project: state.projects,
    thought: state.thoughts,
  }[target.kind];
  const item = items.find((n) => n.id === target.id);
  return (
    item?.title ||
    (item && "content" in item ? item.content.slice(0, 90) : "Unavailable item")
  );
}
export function relatedNotes(state: Workspace, target: NoteTarget) {
  return state.notes.filter((n) =>
    noteTargets(state, n.id).some((t) => targetKey(t) === targetKey(target)),
  );
}
