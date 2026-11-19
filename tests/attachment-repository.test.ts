import { beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mock.createClient }));
import { supabaseRepository } from "../src/repository";
const owner = "10000000-0000-4000-8000-000000000001";
let files: Map<string, Blob>,
  upload: ReturnType<typeof vi.fn>,
  download: ReturnType<typeof vi.fn>;
beforeEach(() => {
  files = new Map();
  download = vi.fn(async (path: string) =>
    files.has(path)
      ? { data: files.get(path), error: null }
      : { data: null, error: { statusCode: "404" } },
  );
  upload = vi.fn(async (path: string, blob: Blob) => {
    files.set(path, blob);
    return { error: null };
  });
  mock.createClient.mockReturnValue({
    auth: {
      getUser: async () => ({ data: { user: { id: owner } }, error: null }),
    },
    storage: { from: () => ({ download, upload }) },
  });
});
test("private file restore accepts matching bytes and rejects a conflicting identity without overwriting", async () => {
  const repository = await supabaseRepository(
    "https://database.invalid",
    "publishable",
  )("user-jwt");
  const blob = new Blob(["%PDF-1.7"], { type: "application/pdf" });
  const ref = await repository.files!.upload(blob);
  expect(ref).toMatch(/^planner-file:\/\/.*\.pdf$/);
  expect(upload.mock.calls[0][0]).toBe(owner + "/" + ref.split("://")[1]);
  expect(upload.mock.calls[0][2]).toEqual({
    upsert: false,
    contentType: "application/pdf",
  });
  await repository.files!.restore(ref, blob);
  expect(upload).toHaveBeenCalledTimes(1);
  await expect(
    repository.files!.restore(
      ref,
      new Blob(["%PDF-different"], { type: "application/pdf" }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(upload).toHaveBeenCalledTimes(1);
  expect(await (await repository.files!.get(ref)).text()).toBe("%PDF-1.7");
  expect(mock.createClient.mock.calls[0][2].global.headers.Authorization).toBe(
    "Bearer user-jwt",
  );
});
test("attachment reads reject forged paths and resolve only within the authenticated owner's directory", async () => {
  const repository = await supabaseRepository(
    "https://database.invalid",
    "publishable",
  )("user-jwt");
  await expect(
    repository.files!.get("planner-file://../foreign/file.pdf"),
  ).rejects.toMatchObject({ status: 422 });
  const key = crypto.randomUUID() + ".pdf";
  files.set(
    "another-owner/" + key,
    new Blob(["%PDF-foreign"], { type: "application/pdf" }),
  );
  await expect(
    repository.files!.get("planner-file://" + key),
  ).rejects.toMatchObject({ status: 404 });
  expect(download.mock.calls.at(-1)?.[0]).toBe(owner + "/" + key);
});
test("a read failure never becomes an overwrite attempt", async () => {
  download.mockResolvedValue({ data: null, error: { statusCode: "503" } });
  const repository = await supabaseRepository(
    "https://database.invalid",
    "publishable",
  )("user-jwt");
  await expect(
    repository.files!.restore(
      "planner-file://" + crypto.randomUUID() + ".pdf",
      new Blob(["%PDF-1.7"], { type: "application/pdf" }),
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(upload).not.toHaveBeenCalled();
});
