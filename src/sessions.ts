import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./repository.js";
import { dayBounds, isDay, isTimeZone } from "./domain/time.js";
export const sessionBatch = z.strictObject({
  timezone: z.string().refine(isTimeZone),
  records: z
    .array(
      z
        .strictObject({
          id: z.uuid(),
          mode: z.enum(["focus", "short", "long"]),
          startedAt: z.number().int().nonnegative(),
          completedAt: z.number().int().nonnegative(),
          durationSeconds: z.number().int().positive().max(86400),
          taskId: z.uuid().nullable().optional(),
          taskTitle: z.string().max(300).optional(),
        })
        .refine(
          (r) =>
            r.durationSeconds ===
              { focus: 1500, short: 300, long: 900 }[r.mode] &&
            r.completedAt >= r.startedAt + r.durationSeconds * 1000 &&
            r.completedAt - r.startedAt <= 7 * 86400000 &&
            r.completedAt <= Date.now() + 60000,
          "Invalid session times.",
        ),
    )
    .max(128),
});
export const sessionQuery = z.strictObject({
  day: z.string().refine(isDay),
  zone: z.string().refine(isTimeZone),
});
export function sessionRepository(client: SupabaseClient, owner: string) {
  const check = (error: unknown) => {
    if (error)
      throw new ApiError(
        503,
        "sessions_unavailable",
        "Focus records could not be synchronized.",
      );
  };
  return {
    async list(input: z.infer<typeof sessionQuery>) {
      const [start, end] = dayBounds(input.day, input.zone);
      const { data, error } = await client
        .from("pomodoro_sessions")
        .select(
          "id,mode,started_at,completed_at,duration_seconds,time_block_id,task_id,task_title",
        )
        .eq("owner_id", owner)
        .gte("completed_at", new Date(start).toISOString())
        .lt("completed_at", new Date(end).toISOString())
        .order("completed_at")
        .limit(1000);
      check(error);
      return data || [];
    },
    async save(input: z.infer<typeof sessionBatch>) {
      if (!input.records.length) return [];
      const { data, error } = await client
        .from("pomodoro_sessions")
        .upsert(
          input.records.map((r) => ({
            owner_id: owner,
            id: r.id,
            mode: r.mode,
            started_at: new Date(r.startedAt).toISOString(),
            completed_at: new Date(r.completedAt).toISOString(),
            duration_seconds: r.durationSeconds,
            timezone: input.timezone,
            task_id: r.taskId || null,
            task_title: r.taskTitle || "",
          })),
          { onConflict: "owner_id,id", ignoreDuplicates: true },
        )
        .select("time_block_id");
      check(error);
      return data || [];
    },
  };
}
