import { sessionRepository } from "./sessions.js";
import { fileKey, validateFile } from "./attachments.js";
import { activityRepository } from "./activity.js";
import { validateImage, validateStoredImage, imageKey } from "./image-store.js";
import { parseWorkspace } from "./domain/validation.js";
import { createClient } from "@supabase/supabase-js";
import { applyCommand } from "./domain/commands.js";
import type { Command, CommandResult } from "./domain/commands.js";
import type { Workspace } from "./domain/model.js";
import { PlannerError } from "./domain/model.js";
import { changesBetween, fromCloud } from "./cloud-mapping.js";
import { accountRecovery } from "./account-recovery.js";
import { recoveryPatch } from "./domain/recovery.js";
export interface ApiRepository {
  activity?: ReturnType<typeof activityRepository>;
  recovery?: ReturnType<typeof accountRecovery>;
  load(): Promise<Workspace>;
  profile?: {
    load(): Promise<string | null>;
    save(username: string): Promise<string>;
  };
  sessions?: ReturnType<typeof sessionRepository>;
  files?: {
    upload(blob: Blob): Promise<string>;
    get(ref: string): Promise<Blob>;
    restore(ref: string, blob: Blob): Promise<void>;
  };
  images?: {
    restore?(ref: string, blob: Blob): Promise<void>;
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
        "planner_load_workspace_with_meals",
      );
      if (error)
        throw new ApiError(
          503,
          "storage_unavailable",
          "Workspace could not be loaded.",
        );
      return fromCloud(data);
    };
    function storedFiles(
      bucket: string,
      prefix: string,
      keyOf: (ref: string) => string | null,
      validate: (blob: Blob) => Promise<string>,
    ) {
      const storage = client.storage.from(bucket);
      const get = async (ref: string) => {
        const key = keyOf(ref);
        if (!key)
          throw new ApiError(
            422,
            "invalid_file",
            "Invalid attachment reference.",
          );
        const { data, error } = await storage.download(`${ownerId}/${key}`);
        if (error || !data)
          throw new ApiError(404, "not_found", "Attachment not found.");
        return data;
      };
      const restore = async (ref: string, blob: Blob) => {
        const key = keyOf(ref),
          ext = await validate(blob);
        if (!key || !key.endsWith(`.${ext}`))
          throw new ApiError(
            422,
            "invalid_file",
            "Invalid attachment reference.",
          );
        const same = async (other: Blob) =>
          Buffer.from(await other.arrayBuffer()).equals(
            Buffer.from(await blob.arrayBuffer()),
          );
        const { data, error } = await storage.download(`${ownerId}/${key}`);
        if (data) {
          if (!(await same(data)))
            throw new ApiError(
              409,
              "file_conflict",
              "This attachment identity has different contents.",
            );
          return;
        }
        if (
          error &&
          !["400", "404"].includes(
            String((error as any).statusCode ?? (error as any).status),
          )
        )
          throw new ApiError(
            503,
            "storage_unavailable",
            "Attachment could not be checked.",
          );
        const { error: write } = await storage.upload(
          `${ownerId}/${key}`,
          blob,
          { upsert: false, contentType: blob.type },
        );
        if (write) {
          const other = await get(ref);
          if (!(await same(other)))
            throw new ApiError(
              409,
              "file_conflict",
              "Attachment restore conflict.",
            );
        }
      };
      return {
        get,
        restore,
        async upload(blob: Blob) {
          const ref = `${prefix}${crypto.randomUUID()}.${await validate(blob)}`;
          await restore(ref, blob);
          return ref;
        },
      };
    }
    return {
      load,
      sessions: sessionRepository(client, ownerId),
      files: storedFiles(
        "planner-attachments",
        "planner-file://",
        fileKey,
        validateFile,
      ),
      recovery: accountRecovery(client, ownerId, load),
      activity: activityRepository(client),
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
        restore: storedFiles(
          "planner-images",
          "planner-image://",
          imageKey,
          validateImage,
        ).restore,
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
        const recoverable =
          command.type.endsWith(".delete") && changes.length > 0;
        const patch = recoverable
          ? recoveryPatch(before, result.snapshot)
          : null;
        const recoveryId = recoverable ? crypto.randomUUID() : undefined;
        const root =
          "id" in command
            ? (Object.values(before)
                .flat()
                .find((r: any) => r?.id === command.id) as any)
            : null;
        if (changes.length) {
          const { error } = await (recoverable
            ? client.rpc("planner_apply_recoverable_changes", {
                changes,
                recovery: {
                  id: recoveryId,
                  kind: command.type.split(".")[0],
                  title: root?.title || root?.description || "Deleted item",
                  payload: patch,
                },
              })
            : command.type === "database.record.save"
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
        return { id: result.id, snapshot: await load(), recoveryId };
      },
    };
  };
}
