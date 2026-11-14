export const habitIconNames = [
  "repeat",
  "water",
  "moon",
  "sun",
  "book",
  "fitness",
  "walk",
  "heart",
  "leaf",
  "coffee",
  "journal",
  "music",
] as const;
export type HabitIconName = (typeof habitIconNames)[number];
