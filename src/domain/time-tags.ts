import { addDays, dateLabel, dayKey, isDay } from "./time";

export type TimeTag = { kind: "date" | "instant"; value: string };
export function validTimeTag(value: unknown): value is TimeTag {
  if (!value || typeof value !== "object") return false;
  const tag = value as TimeTag;
  return (
    typeof tag.value === "string" &&
    (tag.kind === "date"
      ? isDay(tag.value)
      : tag.kind === "instant" &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(tag.value) &&
        !Number.isNaN(Date.parse(tag.value)) &&
        new Date(tag.value).toISOString() === tag.value)
  );
}
export function timeTagURL(tag: TimeTag) {
  return `planner-time://${tag.kind}/${encodeURIComponent(tag.value)}`;
}
export function timeTagFromURL(url: string): TimeTag | null {
  const match = /^planner-time:\/\/(date|instant)\/([^\s/]+)$/.exec(url);
  if (!match) return null;
  try {
    const tag = { kind: match[1], value: decodeURIComponent(match[2]) };
    return validTimeTag(tag) ? tag : null;
  } catch {
    return null;
  }
}
export function timeTagLabel(tag: TimeTag, zone: string) {
  return tag.kind === "date"
    ? dateLabel(tag.value, { month: "short", day: "numeric", year: "numeric" })
    : new Intl.DateTimeFormat("en", {
        timeZone: zone,
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(tag.value));
}
export function timeTagChoices(zone: string, query: string, now = new Date()) {
  const today = dayKey(now, zone);
  const choices: { id: string; title: string; tag: TimeTag }[] = [
    { id: "today", title: "Today", tag: { kind: "date", value: today } },
    {
      id: "now",
      title: "Now",
      tag: { kind: "instant", value: now.toISOString() },
    },
    {
      id: "tomorrow",
      title: "Tomorrow",
      tag: { kind: "date", value: addDays(today, 1) },
    },
    {
      id: "yesterday",
      title: "Yesterday",
      tag: { kind: "date", value: addDays(today, -1) },
    },
    {
      id: "next-week",
      title: "In one week",
      tag: { kind: "date", value: addDays(today, 7) },
    },
  ];
  const q = query.trim().toLowerCase();
  if (isDay(q))
    choices.unshift({
      id: "date",
      title: dateLabel(q, { month: "long", day: "numeric", year: "numeric" }),
      tag: { kind: "date", value: q },
    });
  return choices.filter(
    (c) =>
      c.id === "date" || `${c.title} ${c.tag.value}`.toLowerCase().includes(q),
  );
}
