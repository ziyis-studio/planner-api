import { z } from "zod";
import { isDay } from "./time.js";
import { PlannerError } from "./model.js";
import type { Entity } from "./model.js";
export const databaseFieldTypes = [
  "text",
  "number",
  "date",
  "status",
  "checkbox",
  "tags",
] as const;
export type DatabaseFieldType = (typeof databaseFieldTypes)[number];
export interface DatabaseField {
  id: string;
  name: string;
  type: DatabaseFieldType;
  options: string[];
}
export type DatabaseValue = string | number | boolean | string[];
export interface NoteDatabase extends Entity {
  title: string;
  description: string;
  fields: DatabaseField[];
  noteId: string | null;
}
export interface DatabaseRecord extends Entity {
  databaseId: string;
  title: string;
  content: string;
  values: Record<string, DatabaseValue>;
}
export const databaseFieldsSchema = z
  .array(
    z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(80),
        type: z.enum(databaseFieldTypes),
        options: z.array(z.string().trim().min(1).max(80)).max(50),
      })
      .strict(),
  )
  .max(30)
  .superRefine((fields, ctx) => {
    if (
      new Set(fields.map((f) => f.id)).size !== fields.length ||
      new Set(fields.map((f) => f.name.toLowerCase())).size !== fields.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Field names and identifiers must be unique.",
      });
    for (const field of fields)
      if (new Set(field.options).size !== field.options.length)
        ctx.addIssue({ code: "custom", message: "Options must be unique." });
  });
export const databaseValuesSchema = z.record(
  z.string().uuid(),
  z.union([
    z.string().max(10000),
    z.number().finite(),
    z.boolean(),
    z.array(z.string().max(80)).max(50),
  ]),
);
export function validateDatabaseValues(
  fields: DatabaseField[],
  values: Record<string, DatabaseValue>,
) {
  for (const [id, value] of Object.entries(values)) {
    const field = fields.find((f) => f.id === id);
    if (!field)
      throw new PlannerError(
        "invalid",
        "A record contains an unknown property. Reopen the record.",
      );
    if (value === "") continue;
    const valid =
      field.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : field.type === "checkbox"
          ? typeof value === "boolean"
          : field.type === "tags"
            ? Array.isArray(value) && value.every((v) => typeof v === "string")
            : typeof value === "string" &&
              (field.type === "date"
                ? isDay(value)
                : field.type === "status"
                  ? field.options.includes(value)
                  : true);
    if (!valid)
      throw new PlannerError("invalid", `Invalid value for ${field.name}.`);
  }
}
export function databaseRecordView(
  records: DatabaseRecord[],
  query: string,
  sort: string,
  direction: "asc" | "desc",
  field = "",
  filter = "",
) {
  const text = (v: DatabaseValue | undefined) =>
    Array.isArray(v) ? v.join(", ") : String(v ?? "");
  return records
    .filter(
      (r) =>
        `${r.title} ${r.content} ${Object.values(r.values).map(text).join(" ")}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()) &&
        (!field ||
          !filter ||
          text(r.values[field]).toLowerCase().includes(filter.toLowerCase())),
    )
    .sort((a, b) => {
      const av =
        sort === "title"
          ? a.title
          : sort === "updatedAt"
            ? a.updatedAt
            : a.values[sort];
      const bv =
        sort === "title"
          ? b.title
          : sort === "updatedAt"
            ? b.updatedAt
            : b.values[sort];
      const result =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : text(av).localeCompare(text(bv), undefined, { numeric: true });
      return (
        (direction === "asc" ? result : -result) || a.id.localeCompare(b.id)
      );
    });
}
