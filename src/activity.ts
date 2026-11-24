import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./repository.js";
import {
  activitySchema,
  activityDeleteSchema,
  activityWriteSchema,
  activityQuerySchema,
} from "./domain/activity.js";
import type { ActivityQuery } from "./domain/activity.js";
function check(error: { code?: string } | null) {
  if (error)
    throw new ApiError(
      error.code === "PT404" ? 404 : error.code === "PT409" ? 409 : 503,
      "activity_error",
      error.code === "PT404"
        ? "This item no longer exists."
        : error.code === "PT409"
          ? "This entry was already saved with different contents. Your draft was kept."
          : "The log could not be saved or loaded. Please retry.",
    );
}
function entry(row: any) {
  // Postgres and PostgREST timestamp spellings differ. Preserve fractional
  // precision because the exact timestamp is also the pagination cursor.
  const timestamp =
    typeof row?.created_at === "string"
      ? row.created_at.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")
      : row?.created_at;
  const parsed = activitySchema.safeParse({
    id: row.id,
    target_kind: row.target_kind,
    target_id: row.target_id,
    body: row.body,
    created_at: timestamp,
  });
  if (!parsed.success)
    throw new ApiError(
      503,
      "activity_response_invalid",
      "The log could not be read. Please retry; saved entries are kept.",
    );
  return parsed.data;
}
export function activityRepository(client: SupabaseClient) {
  return {
    async list(raw: ActivityQuery) {
      const q = activityQuerySchema.parse(raw);
      const { data, error } = await client.rpc("planner_activity_log", {
        entity_kind: q.kind,
        entity_id: q.id,
        before_at: q.beforeAt || null,
        before_id: q.beforeId || null,
      });
      check(error);
      const rows = (data || []).map(entry),
        items = rows.slice(0, 50),
        last = items.at(-1);
      return {
        items,
        next:
          rows.length > 50 && last
            ? { beforeAt: last.created_at, beforeId: last.id }
            : null,
      };
    },
    async remove(raw: unknown) {
      const q = activityDeleteSchema.parse(raw);
      const { error } = await client.rpc("planner_delete_log", {
        entry_id: q.id,
        entity_kind: q.kind,
        entity_id: q.targetId,
      });
      check(error);
    },
    async append(raw: unknown) {
      const q = activityWriteSchema.parse(raw);
      const { data, error } = await client.rpc("planner_append_log", {
        entry_id: q.id,
        entity_kind: q.kind,
        entity_id: q.targetId,
        entry_body: q.body,
      });
      check(error);
      return entry(Array.isArray(data) ? data[0] : data);
    },
  };
}
