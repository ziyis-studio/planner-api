export type TagGraphQuery = {
  q: string;
  kind: "all" | "task" | "project" | "note";
  tag: string;
  includeCompleted: boolean;
  includeUntagged: boolean;
};
export type TagGraphNode = {
  id: string;
  kind: "task" | "project" | "note" | "tag";
  label: string;
  entityId?: string;
  stage?: "todo" | "progress" | "hold" | "done";
  projectTitle?: string;
  context?: boolean;
  tags: string[];
  connections: number;
};
export type TagGraphLink = {
  source: string;
  target: string;
  kind: "tag" | "project" | "reference";
  inherited?: boolean;
};
export type TagGraph = {
  nodes: TagGraphNode[];
  links: TagGraphLink[];
  availableTags: { name: string; items: number }[];
  totalMatches: number;
  shownItems: number;
  truncated: boolean;
};

export type TagOption = { name: string; items: number };
export type TagOptions = {
  items: TagOption[];
  total: number;
  selected: string[];
  create: { name: string; allowed: boolean; reason?: string } | null;
};
export type TagListRow = {
  name: string | null;
  count: number;
  tasks: number;
  projects: number;
  notes: number;
};
export type TagListQuery = TagGraphQuery & {
  offset: number;
  limit: number;
  onlyUntagged: boolean;
};
export type TagListPage = {
  availableTags: TagOption[];
  mode: "tags" | "items";
  rows: TagListRow[];
  items: TagGraphNode[];
  total: number;
  offset: number;
  limit: number;
};
