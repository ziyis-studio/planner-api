import { z } from "zod";
import type { Entity } from "./model.js";
import { isTimeZone } from "./time.js";

export const mealKinds = [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "other",
] as const;
export const nutrientKeys = [
  "calories",
  "protein",
  "carbs",
  "fat",
  "fiber",
] as const;
export type Nutrient = (typeof nutrientKeys)[number];
export const mealPhotoSchema = z.strictObject({
  ref: z
    .string()
    .regex(
      /^planner-image:\/\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/,
    ),
  alt: z.string().trim().max(160),
});
const amount = z
  .number()
  .finite()
  .min(0)
  .max(100000)
  .multipleOf(0.01)
  .nullable()
  .default(null);
export const mealFieldsSchema = z
  .strictObject({
    title: z.string().trim().max(300).default(""),
    description: z.string().trim().max(10000).default(""),
    kind: z.enum(mealKinds),
    ateAt: z.string().datetime({ offset: true }),
    timeZone: z.string().refine(isTimeZone),
    photos: z.array(mealPhotoSchema).max(6).default([]),
    calories: amount,
    protein: amount,
    carbs: amount,
    fat: amount,
    fiber: amount,
    nutritionSource: z.enum(["manual", "external"]).default("manual"),
  })
  .superRefine((meal, context) => {
    if (!meal.title && !meal.description && !meal.photos.length)
      context.addIssue({
        code: "custom",
        message: "Describe your meal or add a photo.",
        path: ["description"],
      });
    if (new Set(meal.photos.map((p) => p.ref)).size !== meal.photos.length)
      context.addIssue({
        code: "custom",
        message: "A photo can only be attached once.",
        path: ["photos"],
      });
  });
export const mealRecordSchema = mealFieldsSchema.safeExtend({
  id: z.uuid(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type MealInput = z.input<typeof mealFieldsSchema>;
export type Meal = Entity & z.output<typeof mealFieldsSchema>;
export type MealPhoto = z.infer<typeof mealPhotoSchema>;
export type MealDay = {
  date: string;
  meals: Meal[];
  totals: Record<Nutrient, { amount: number | null; recorded: number }>;
  history: {
    date: string;
    calories: number | null;
    recorded: number;
    meals: number;
  }[];
};
