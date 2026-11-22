import { z } from "zod";
import type { Workspace } from "./domain/model.js";
import type {
  TagGraph,
  TagGraphNode,
  TagGraphQuery,
} from "./domain/tag-graph.js";
export const tagGraphQuery = z.strictObject({
  q: z.string().trim().max(200).default(""),
  kind: z.enum(["all", "task", "project", "note"]).default("all"),
  tag: z.string().trim().max(40).default(""),
  includeCompleted: z.boolean().default(true),
  includeUntagged: z.boolean().default(false),
});
const tags = (values: string[] = []) => [
  ...new Set(values.map((t) => t.trim().toLowerCase()).filter(Boolean)),
];
const tagId = (name: string) => "tag:" + encodeURIComponent(name);
/** Derive owner-scoped relationships and filters on the API, never in the browser. */
export function tagRecords(state: Workspace) {
  const projects = new Map(state.projects.map((p) => [p.id, p]));
  const items: (TagGraphNode & {
    search: string;
    direct: string[];
    projectId?: string | null;
  })[] = [
    ...state.projects.map((p) => ({
      id: "project:" + p.id,
      entityId: p.id,
      kind: "project" as const,
      label: p.title,
      tags: tags(p.tags),
      direct: tags(p.tags),
      connections: 0,
      search: p.description,
      stage: p.completedAt
        ? ("done" as const)
        : p.workStatus === "on_hold"
          ? ("hold" as const)
          : ("progress" as const),
    })),
    ...state.tasks.map((t) => ({
      id: "task:" + t.id,
      entityId: t.id,
      kind: "task" as const,
      label: t.title,
      tags: tags([
        ...(projects.get(t.projectId || "")?.tags || []),
        ...(t.tags || []),
      ]),
      direct: tags(t.tags),
      connections: 0,
      projectId: t.projectId,
      projectTitle: projects.get(t.projectId || "")?.title || "Personal",
      search: t.description,
      stage: t.completedAt
        ? ("done" as const)
        : t.workStatus === "on_hold"
          ? ("hold" as const)
          : t.startedAt
            ? ("progress" as const)
            : ("todo" as const),
    })),
    ...state.notes.map((n) => ({
      id: "note:" + n.id,
      entityId: n.id,
      kind: "note" as const,
      label: n.title,
      tags: tags(n.tags),
      direct: tags(n.tags),
      connections: 0,
      search: n.content,
    })),
  ];
  return items;
}
export function tagGraph(state: Workspace, query: TagGraphQuery): TagGraph {
  const items = tagRecords(state);
  const byId = new Map(items.map((i) => [i.id, i]));
  const base = items.filter(
    (i) =>
      (query.kind === "all" || i.kind === query.kind) &&
      (query.includeCompleted || i.stage !== "done"),
  );
  const available = new Map<string, number>(
    state.tagCatalog.map((t) => [t.name.trim().toLowerCase(), 0]),
  );
  for (const item of base)
    for (const name of item.tags)
      available.set(name, (available.get(name) || 0) + 1);
  const q = query.q.toLowerCase(),
    selectedTag = query.tag.toLowerCase();
  const matches = base
    .filter(
      (i) =>
        (query.includeUntagged || i.tags.length > 0) &&
        (!selectedTag || i.tags.includes(selectedTag)) &&
        (!q ||
          [i.label, i.search, i.projectTitle || "", ...i.tags]
            .join(" ")
            .toLowerCase()
            .includes(q)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const nodes = new Map<string, TagGraphNode>(),
    edges = new Map<string, TagGraph["links"][number]>();
  function add(node: TagGraphNode) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    else if (!node.context) nodes.get(node.id)!.context = false;
  }
  function tagNode(name: string) {
    add({
      id: tagId(name),
      kind: "tag",
      label: name,
      tags: [],
      connections: 0,
    });
  }
  function link(
    source: string,
    target: string,
    kind: "tag" | "project" | "reference",
    inherited = false,
  ) {
    edges.set(source + "/" + target + "/" + kind, {
      source,
      target,
      kind,
      ...(inherited ? { inherited: true } : {}),
    });
  }
  function publicNode(
    item: (typeof items)[number],
    context = false,
  ): TagGraphNode {
    const { search: _, direct: __, projectId: ___, ...node } = item;
    return { ...node, context };
  }
  function addItem(item: (typeof items)[number], context = false) {
    add(publicNode(item, context));
    for (const name of item.tags) {
      tagNode(name);
      link(item.id, tagId(name), "tag", !item.direct.includes(name));
    }
  }
  let shownItems = 0;
  for (const item of matches) {
    const project =
      item.kind === "task" ? byId.get("project:" + item.projectId) : null;
    const needed = [
      ...new Set([
        item.id,
        ...item.tags.map(tagId),
        ...(project ? [project.id, ...project.tags.map(tagId)] : []),
      ]),
    ].filter((id) => !nodes.has(id));
    // Bound the interactive surface while retaining every displayed item's relations.
    if (nodes.size + needed.length > 600) continue;
    addItem(item);
    if (project) {
      if (!nodes.has(project.id)) addItem(project, true);
      link(item.id, project.id, "project");
    }
    shownItems++;
  }
  for (const name of [...available.keys()].sort())
    if (
      (!selectedTag || name === selectedTag) &&
      (!q || name.includes(q)) &&
      nodes.size < 600
    )
      tagNode(name);
  for (const edge of state.noteLinks) {
    const source = "note:" + edge.noteId,
      target = edge.targetNoteId
        ? "note:" + edge.targetNoteId
        : edge.taskId
          ? "task:" + edge.taskId
          : edge.projectId
            ? "project:" + edge.projectId
            : "";
    if (nodes.has(source) && nodes.has(target))
      link(source, target, "reference");
  }
  const links = [...edges.values()];
  for (const edge of links) {
    nodes.get(edge.source)!.connections++;
    nodes.get(edge.target)!.connections++;
  }
  return {
    nodes: [...nodes.values()],
    links,
    availableTags: [...available]
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    totalMatches: matches.length,
    shownItems,
    truncated:
      shownItems < matches.length ||
      [...available.keys()].some(
        (name) =>
          (!selectedTag || name === selectedTag) &&
          (!q || name.includes(q)) &&
          !nodes.has(tagId(name)),
      ),
  };
}
