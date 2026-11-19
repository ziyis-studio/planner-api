import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./repository.js";
import { fromCloud, changesBetween } from "./cloud-mapping.js";
import {
  parseBackup,
  copyBackup,
  mergeWorkspace,
  restorePatch,
} from "./domain/recovery.js";
import type { Workspace } from "./domain/model.js";
import type { RecoveryEntry } from "./domain/recovery.js";
const fail = (error: { code?: string; message?: string } | null) => {
  if (error)
    throw new ApiError(
      ["PT409", "23505"].includes(error.code || "") ? 409 : 503,
      "recovery_error",
      ["PT409", "23505"].includes(error.code || "")
        ? "Data changed. Refresh before restoring."
        : "Recovery could not be completed.",
    );
};
export function accountRecovery(
  client: SupabaseClient,
  owner: string,
  load: () => Promise<Workspace>,
) {
  const entry = (r: any): RecoveryEntry => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    deletedAt: r.deleted_at,
    restoredAt: r.restored_at,
    patch: r.payload,
  });
  return {
    async list(offset = 0) {
      const { data, error } = await client
        .from("planner_recovery")
        .select("id,kind,title,deleted_at,restored_at")
        .eq("owner_id", owner)
        .is("restored_at", null)
        .order("deleted_at", { ascending: false })
        .range(offset, offset + 49);
      fail(error);
      return (data || []).map(entry);
    },
    async restore(id: string) {
      const { data, error } = await client
        .from("planner_recovery")
        .select("*")
        .eq("owner_id", owner)
        .eq("id", id)
        .single();
      fail(error);
      const before = await load();
      if (data.restored_at) return { snapshot: before };
      const after = restorePatch(before, data.payload);
      const { error: write } = await client.rpc("planner_restore_recovery", {
        entry_id: id,
        changes: changesBetween(before, after),
        recorded_blocks: after.timeBlocks.filter((b) => b.sourceSessionId),
      });
      fail(write);
      return { snapshot: await load() };
    },
    async purge(id: string) {
      const { error } = await client
        .from("planner_recovery")
        .delete()
        .eq("owner_id", owner)
        .eq("id", id);
      fail(error);
    },
    async backup() {
      const { data, error } = await client.rpc(
        "planner_export_backup_with_ordering",
      );
      fail(error);
      return parseBackup({ ...data, workspace: fromCloud(data.workspace) });
    },
    async import(raw: unknown, asCopy = false) {
      const { backup, idMap } = await copyBackup(
        parseBackup(raw),
        owner,
        asCopy,
      );
      const before = await load(),
        after = mergeWorkspace(before, backup.workspace);
      const { error } = await client.rpc(
        "planner_import_backup_with_activity",
        {
          changes: changesBetween(before, after),
          sessions: backup.sessions,
          trash: backup.trash,
          activity: backup.activity || [],
          recorded_blocks: after.timeBlocks.filter((b) => b.sourceSessionId),
        },
      );
      fail(error);
      return { snapshot: await load(), idMap };
    },
  };
}
