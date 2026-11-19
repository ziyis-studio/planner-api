import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

test("private attachments reject anonymous and cross-owner access, forged paths and overwrite, even beside a broad policy", async () => {
  const db = new PGlite();
  const owner = "10000000-0000-4000-8000-000000000001";
  const other = "10000000-0000-4000-8000-000000000002";
  const filename = "10000000-0000-4000-8000-000000000003.pdf";
  try {
    await db.exec(`create role authenticated; create role anon; create schema auth; create schema storage;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(bucket_id text,name text,owner_id text);
      create function storage.foldername(text) returns text[] language sql immutable as $$ select (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1] $$;
      create function storage.filename(text) returns text language sql immutable as $$ select (string_to_array($1,'/'))[array_length(string_to_array($1,'/'),1)] $$;
      alter table storage.objects enable row level security;
      grant usage on schema storage,auth to authenticated,anon;
      grant all on storage.objects to authenticated,anon;`);
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/20261119130433_attachments_image_uploads.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      (
        await db.query<{ public: boolean }>(
          "select public from storage.buckets",
        )
      ).rows[0].public,
    ).toBe(false);
    await db.exec(
      `set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false);`,
    );
    await db.query("insert into storage.objects values ($1,$2,$3)", [
      "planner-attachments",
      `${owner}/${filename}`,
      owner,
    ]);
    expect((await db.query("select * from storage.objects")).rows).toHaveLength(
      1,
    );
    await expect(
      db.query("insert into storage.objects values ($1,$2,$3)", [
        "planner-attachments",
        `${other}/${filename}`,
        owner,
      ]),
    ).rejects.toThrow("row-level security");
    await expect(
      db.query("insert into storage.objects values ($1,$2,$3)", [
        "planner-attachments",
        `${owner}/nested/${filename}`,
        owner,
      ]),
    ).rejects.toThrow("row-level security");
    expect(
      (
        await db.query("update storage.objects set owner_id=$1 returning *", [
          other,
        ])
      ).rows,
    ).toHaveLength(0);
    await db.exec(
      `select set_config('request.jwt.claim.sub','${other}',false);`,
    );
    expect((await db.query("select * from storage.objects")).rows).toHaveLength(
      0,
    );
    expect(
      (await db.query("delete from storage.objects returning *")).rows,
    ).toHaveLength(0);
    await db.exec(
      `reset role; create policy broad_read on storage.objects for select to public using (true); set role anon; select set_config('request.jwt.claim.sub','',false);`,
    );
    expect((await db.query("select * from storage.objects")).rows).toHaveLength(
      0,
    );
    await db.exec(
      `set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false);`,
    );
    expect(
      (await db.query("delete from storage.objects returning *")).rows,
    ).toHaveLength(1);
  } finally {
    await db.close();
  }
}, 30000);
