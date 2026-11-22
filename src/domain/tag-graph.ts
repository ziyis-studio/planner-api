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
