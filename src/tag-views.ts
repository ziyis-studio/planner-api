import { z } from "zod";
import type { Workspace } from "./domain/model.js";
import type {
  TagOptions,
  TagListPage,
  TagListQuery,
  TagListRow,
  TagGraphNode,
} from "./domain/tag-graph.js";
import { normalizeTags } from "./domain/tags.js";
import { tagGraphQuery, tagRecords } from "./tag-graph.js";
export const tagOptionsQuery = z.strictObject({
  q: z.string().max(200).default(""),
  selected: z.array(z.string().max(40)).max(30).default([]),
});
export const tagListQuery = tagGraphQuery.extend({
  offset: z.number().int().min(0).max(1000000).default(0),
  limit: z.number().int().min(1).max(100).default(30),
  onlyUntagged: z.boolean().default(false),
});
export function tagOptions(
  state: Workspace,
  query: z.infer<typeof tagOptionsQuery>,
): TagOptions {
  const counts = new Map<string, number>();
  for (const t of state.tagCatalog) counts.set(t.name.trim().toLowerCase(), 0);
  for (const item of tagRecords(state))
    for (const name of item.tags) counts.set(name, (counts.get(name) || 0) + 1);
  const selected = normalizeTags(query.selected);
  for (const name of selected) if (!counts.has(name)) counts.set(name, 0);
  const name = query.q.trim().toLowerCase(),
    matches = [...counts]
      .filter(([tag]) => tag.includes(name))
      .sort((a, b) => a[0].localeCompare(b[0]));
  const reason =
    name.length > 40
      ? "Use up to 40 characters for a tag."
      : selected.length >= 30
        ? "Use up to 30 tags per item."
        : undefined;
  return {
    items: matches.slice(0, 50).map(([name, items]) => ({ name, items })),
    total: matches.length,
    selected,
    create:
      name && !counts.has(name)
        ? { name, allowed: !reason, ...(reason ? { reason } : {}) }
        : null,
  };
}
export function tagList(state: Workspace, query: TagListQuery): TagListPage {
  const records = tagRecords(state);
  const catalog = new Map<string, number>(
    state.tagCatalog.map((t) => [t.name.trim().toLowerCase(), 0]),
  );
  for (const record of records)
    if (
      (query.kind === "all" || record.kind === query.kind) &&
      (query.includeCompleted || record.stage !== "done")
    )
      for (const name of record.tags)
        catalog.set(name, (catalog.get(name) || 0) + 1);
  const availableTags = [...catalog]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const q = query.q.toLowerCase(),
    tag = query.tag.toLowerCase();
  const items = records
    .filter(
      (i) =>
        (query.kind === "all" || i.kind === query.kind) &&
        (query.includeCompleted || i.stage !== "done") &&
        (query.onlyUntagged
          ? i.tags.length === 0
          : query.includeUntagged || i.tags.length > 0) &&
        (!tag || i.tags.includes(tag)) &&
        (!q ||
          [i.label, i.search, i.projectTitle || "", ...i.tags]
            .join(" ")
            .toLowerCase()
            .includes(q)),
    )
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const page = { offset: query.offset, limit: query.limit, availableTags };
  if (tag || query.onlyUntagged) {
    const nodes = items
      .slice(query.offset, query.offset + query.limit)
      .map((item) => {
        const { search: _, direct: __, projectId: ___, ...node } = item;
        return node as TagGraphNode;
      });
    return {
      ...page,
      mode: "items",
      rows: [],
      items: nodes,
      total: items.length,
    };
  }
  const groups = new Map<string | null, TagListRow>();
  function row(name: string | null) {
    if (!groups.has(name))
      groups.set(name, { name, count: 0, tasks: 0, projects: 0, notes: 0 });
    return groups.get(name)!;
  }
  for (const item of items) {
    for (const name of item.tags.length ? item.tags : [null]) {
      const group = row(name);
      group.count++;
      group[
        item.kind === "task"
          ? "tasks"
          : item.kind === "project"
            ? "projects"
            : "notes"
      ]++;
    }
  }
  for (const tag of state.tagCatalog) {
    const name = tag.name.trim().toLowerCase();
    if (!q || name.includes(q)) row(name);
  }
  const rows = [...groups.values()].sort((a, b) =>
    a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name),
  );
  return {
    ...page,
    mode: "tags",
    rows: rows.slice(query.offset, query.offset + query.limit),
    items: [],
    total: rows.length,
  };
}
