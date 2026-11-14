import { validateImage, validateStoredImage, imageKey } from "./image-store";
import { parseWorkspace } from "./domain/validation";
import { createClient } from "@supabase/supabase-js";
import { applyCommand } from "./domain/commands";
import type { Command, CommandResult } from "./domain/commands";
import type { Workspace } from "./domain/model";
import { PlannerError } from "./domain/model";
import { changesBetween, fromCloud } from "./cloud-mapping";
export interface ApiRepository {
  load(): Promise<Workspace>;
  profile?: {
    load(): Promise<string | null>;
    save(username: string): Promise<string>;
  };
  images?: {
    upload(blob: Blob): Promise<string>;
    get(ref: string): Promise<Blob>;
  };
  execute(command: Command): Promise<CommandResult>;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function supabaseRepository(url: string, key: string) {
  return async (token: string): Promise<ApiRepository> => {
    const client = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user)
      throw new ApiError(401, "unauthorized", "Sign in again.");
    const ownerId = data.user.id;
    const load = async () => {
      const { data, error } = await client.rpc(
        "planner_load_workspace_with_databases",
      );
      if (error)
        throw new ApiError(
          503,
          "storage_unavailable",
          "Workspace could not be loaded.",
        );
      return fromCloud(data);
    };
    return {
      load,
      profile: {
        async load() {
          const { data, error } = await client
            .from("account_profiles")
            .select("username")
            .maybeSingle();
          if (error)
            throw new ApiError(
              503,
              "storage_unavailable",
              "Profile could not be loaded.",
            );
          return data?.username ?? null;
        },
        async save(username) {
          const { data, error } = await client
            .from("account_profiles")
            .upsert({ user_id: ownerId, username }, { onConflict: "user_id" })
            .select("username")
            .single();
          if (error)
            throw new ApiError(
              error.code === "23505" ? 409 : 503,
              "profile_error",
              error.code === "23505"
                ? "Username already taken."
                : "Profile could not be saved.",
            );
          return data.username;
        },
      },
      images: {
        async upload(blob) {
          let ext: string;
          try {
            ext = await validateImage(blob);
          } catch (error) {
            throw new ApiError(422, "invalid_image", (error as Error).message);
          }
          const key = `${crypto.randomUUID()}.${ext}`;
          const { error } = await client.storage
            .from("planner-images")
            .upload(`${ownerId}/${key}`, blob, {
              contentType: blob.type,
              upsert: false,
            });
          if (error)
            throw new ApiError(
              503,
              "storage_unavailable",
              "Image upload failed.",
            );
          return `planner-image://${key}`;
        },
        async get(ref) {
          const key = imageKey(ref);
          if (!key)
            throw new ApiError(
              422,
              "invalid_image",
              "Invalid image reference.",
            );
          const { data, error } = await client.storage
            .from("planner-images")
            .download(`${ownerId}/${key}`);
          if (error || !data)
            throw new ApiError(404, "not_found", "Image not found.");
          await validateStoredImage(ref, data);
          return data;
        },
      },
      async execute(command) {
        const before = await load();
        const result = applyCommand(before, command);
        parseWorkspace(result.snapshot);
        const changes = changesBetween(before, result.snapshot);
        if (changes.length) {
          const { error } = await (command.type === "database.record.save"
            ? client.rpc("planner_apply_database_record_changes", {
                changes,
                database_id: command.input.databaseId,
                database_revision: command.databaseRevision,
              })
            : client.rpc("planner_apply_changes", { changes }));
          if (error) {
            if (
              command.type === "occurrences.materialize" &&
              error.code === "23505"
            )
              return { snapshot: await load() };
            if (["PT409", "40001", "23505"].includes(error.code))
              throw new PlannerError(
                "conflict",
                "Data changed. Reload before retrying.",
              );
            if (error.code.startsWith("22") || error.code.startsWith("23"))
              throw new ApiError(
                422,
                "invalid",
                "The change violates a data constraint.",
              );
            throw new ApiError(
              503,
              "storage_unavailable",
              "The change could not be saved.",
            );
          }
        }
        return { id: result.id, snapshot: await load() };
      },
    };
  };
}
