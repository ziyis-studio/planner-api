import type { NoteTarget } from "./model.js";
import { timeTagFromURL } from "./time-tags.js";
export function internalNoteTarget(url: string): NoteTarget | null {
  const match =
    /^planner:\/\/(note|task|project|thought)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      url,
    );
  return match
    ? {
        kind: match[1].toLowerCase() as NoteTarget["kind"],
        id: match[2].toLowerCase(),
      }
    : null;
}
export function safeEditorURL(url: string) {
  return !!(
    internalNoteTarget(url) ||
    timeTagFromURL(url) ||
    /^(https?:\/\/|mailto:|#)/i.test(url)
  );
}
export function descriptionExcerpt(value: string) {
  return value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^(?:#{1,6}|>|[-*])\s+/gm, "")
    .replace(/[*_`]/g, "")
    .trim();
}
