export const projectIconNames = [
  "folder",
  "home",
  "briefcase",
  "code",
  "palette",
  "book",
  "graduation",
  "heart",
  "plane",
  "fitness",
  "leaf",
  "sparkles",
] as const;
export type ProjectIconName = (typeof projectIconNames)[number];
