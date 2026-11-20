import { z } from "zod";
import { addDays, dayKey, isDay, isTimeZone } from "./domain/time.js";
import { nutrientKeys } from "./domain/meals.js";
import type { MealDay, Nutrient } from "./domain/meals.js";
import type { Workspace } from "./domain/model.js";
export const mealQuery = z.strictObject({
  date: z.string().refine(isDay),
  zone: z.string().refine(isTimeZone),
});
export function mealDay(
  state: Workspace,
  query: z.infer<typeof mealQuery>,
): MealDay {
  const byDate = new Map<string, typeof state.meals>();
  for (const meal of state.meals) {
    const date = dayKey(meal.ateAt, query.zone);
    const rows = byDate.get(date) || [];
    rows.push(meal);
    byDate.set(date, rows);
  }
  const meals = (byDate.get(query.date) || []).toSorted(
    (a, b) => b.ateAt.localeCompare(a.ateAt) || a.id.localeCompare(b.id),
  );
  const sum = (rows: typeof meals, key: Nutrient) => {
    const values = rows
      .map((m) => m[key])
      .filter((n): n is number => n !== null);
    return {
      amount: values.length
        ? Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100
        : null,
      recorded: values.length,
    };
  };
  return {
    date: query.date,
    meals,
    totals: Object.fromEntries(
      nutrientKeys.map((key) => [key, sum(meals, key)]),
    ) as MealDay["totals"],
    history: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(query.date, i - 6),
        rows = byDate.get(date) || [],
        total = sum(rows, "calories");
      return {
        date,
        calories: total.amount,
        recorded: total.recorded,
        meals: rows.length,
      };
    }),
  };
}
