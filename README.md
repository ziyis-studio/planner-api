# Planner API

Independent backend for Planner. This repository owns domain mutations, Supabase migrations, private image storage access, profile persistence, and the username-login Edge Function. It does not import or serve the frontend. Extracted from `planner-core` (base commit `6060e43c1edd5f2403e2abeb7d176a78a5dbd71f`) with the notes/database API additions.

## Local startup

Node 24.19.0 and pnpm 11.25.0:

```sh
corepack pnpm install --frozen-lockfile
cp .env.example .env
# Fill in your Supabase URL, publishable key and frontend origin.
corepack pnpm dev
```

`API_ALLOWED_ORIGINS` is a comma-separated allowlist, for example `http://localhost:3000,http://127.0.0.1:3000`. `HOST` defaults to `127.0.0.1`, `PORT` to `3001`. The frontend must set `VITE_API_URL=http://127.0.0.1:3001` and retain its Supabase Auth URL/publishable key.

Before connecting to an existing Planner Supabase project, apply the new additive `supabase/migrations/20261114141302_note_databases.sql` migration. Do not rerun historical migrations already applied to that project. New projects need the complete ordered migration chain. Existing tables, ownership policies and user records are preserved.

## Deploy independently

```sh
docker build -t planner-api .
docker run --env-file .env -e HOST=0.0.0.0 -p 3001:3001 planner-api
```

Deploy this API on its own HTTPS origin. Configure frontend `VITE_API_URL` only after authenticated API checks pass. Set the backend CORS allowlist to the exact frontend origins. The health endpoint is a process liveness check, not a database-readiness guarantee. Keep gateway rate/request limits enabled. No automatic mutation retries: an interrupted response can follow a committed write, so reload before retrying.

The frontend remains independently built and deployed from `planner-core`. Cloud mode sends all workspace reads/writes, profile operations and images to this API. Supabase Auth remains the identity provider; email/OAuth/session refresh and the existing username-login Edge Function are authentication paths, not direct business-data access. Optional local/demo mode remains offline and never acts as a fallback for API failures. Weather is an external public-data integration and remains independent of workspace persistence.

## API contract

All `/v1` routes except `/v1/health` require `Authorization: Bearer <Supabase user access token>`. Each request verifies the token and uses its JWT for RLS; there is no shared service-role client. All business rules execute on the server. UI checks are only hints.

| Method     | Endpoint                                                                                                                       | Result                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| GET        | `/v1/health`                                                                                                                   | `{status:"ok",version:1}`                                            |
| GET        | `/v1/workspace`                                                                                                                | `{data: Workspace}`                                                  |
| POST       | `/v1/commands`                                                                                                                 | `{data: {snapshot: Workspace, id?: string}}`                         |
| GET        | `/v1/tasks`, `/projects`, `/conditions`, `/thoughts`, `/habits`, `/occurrences`, `/executions`, `/schedule`, `/sleep`, `/tags` | `{data: rows, meta: {total,limit,offset}}`                           |
| GET        | any collection above + `/:id`                                                                                                  | `{data: entity}`                                                     |
| GET, PATCH | `/v1/profile`                                                                                                                  | `{data:{username}}`; PATCH body `{username}`                         |
| POST       | `/v1/images`                                                                                                                   | Raw PNG/JPEG/WebP/GIF body with Content-Type; returns `{data:{ref}}` |
| GET        | `/v1/images/:filename`                                                                                                         | Private image binary; filename from `planner-image://` reference     |

Lists accept `q`, `limit` (1–100), `offset`. IDs are UUIDs. JSON payloads are bounded to 1 MiB; images to 5 MiB and checked against file signatures. No client-supplied owner paths are accepted. Images are stored immutably under the authenticated owner's directory.

### Atomic commands

One command is a business transaction. Commands are strictly validated against `src/command-schema.ts` (unknown fields and operations are rejected) before invoking `src/domain/commands.ts`. This preserves compound operations such as project reopening, thought conversion and condition checks without exposing raw table writes. Existing clients can submit the same command structure as before:

```json
{
  "type": "task.create",
  "input": {
    "title": "Review draft",
    "projectId": null,
    "conditions": ["Check references"],
    "tags": ["work"]
  }
}
```

```json
{
  "type": "task.update",
  "id": "<uuid>",
  "expectedUpdatedAt": "<server revision>",
  "patch": { "workStatus": "on_hold" }
}
```

```json
{
  "type": "task.complete",
  "id": "<uuid>",
  "expectedUpdatedAt": "<server revision>"
}
```

Supported command groups:

- Task: create, update, delete, complete, reopen, continue, reorderConditions.
- Project: create, update, delete, complete, reopen, reorderTasks.
- Condition: add, update, delete.
- Thought: create, update, delete, convert, link, unlink.
- Habit: create, update, delete; occurrences.materialize; occurrence.reschedule.
- Execution: record, update, delete.
- Block (schedule): save, delete.
- Sleep: save, delete.
- Note: save, delete.
- Tag: create, rename (null destination removes the tag).
- Database: save, delete; database.record.save, database.record.delete.

Exact required/optional inputs are defined in `src/domain/commands.ts`; wire validation is exhaustive for every command type. `expectedUpdatedAt` is an opaque server revision, not a client-generated timestamp. Existing commands that do not accept it still execute against fresh owner-scoped state with transactional row revision checks. Record writes additionally require `databaseRevision`, checked under the transaction lock. A command cannot mark a task complete if its conditions remain unmet, or a project complete while tasks remain open. Scheduling does not imply completion.

### Notes and typed databases

| Endpoint                    | Methods            |
| --------------------------- | ------------------ |
| `/v1/notes`                 | GET, POST          |
| `/v1/notes/:id`             | GET, PATCH, DELETE |
| `/v1/notes/:id/databases`   | GET                |
| `/v1/databases`             | GET, POST          |
| `/v1/databases/:id`         | GET, PATCH, DELETE |
| `/v1/databases/:id/records` | GET, POST          |
| `/v1/records/:id`           | GET, PATCH, DELETE |

These REST routes return `{data}`. Single-resource reads/writes include an ETag; PATCH/DELETE require `If-Match`. PATCH preserves omitted fields. DELETE returns 204. Notes use `{title,content,tags}` with Markdown content. Databases use `{title,description,noteId,fields}`. Each field has `{id,name,type,options}` with UUID identity and one of `text`, `number`, `date`, `status`, `checkbox`, `tags`. Records use `{title,content,values,databaseRevision}`; values are keyed by field UUID. PATCH `values` replaces the map. Deleting a note detaches its databases; deleting a database cascades its records. Removing a field cleans up values atomically; changing its type requires a new field.

Notes/databases list sorting supports `sort=title|updatedAt&direction=asc|desc`. Records also sort by field UUID and accept `field=<uuid>&filter=<substring>`. Numbers sort numerically.

This is a Markdown/page-and-database foundation, not full Notion parity: collaborative block IDs, formulas, relations/rollups and multi-view editor UI are not implemented.

## Errors and concurrency

Errors return `{error:{code,message,details?}}` with `X-Request-Id`. Responses are no-store. 401 indicates authentication failure; 403 denied origin; 404 missing/inaccessible resource; 409/412 a conflict; 413 oversized body; 415 content type; 422 validation or completion gate; 428 missing ETag; 503 storage unavailable. The frontend preserves domain error codes such as `conditions_unmet` and `tasks_incomplete`. There is no silent local-storage fallback.

Workspace reads currently use a single owner-scoped snapshot, and list pagination/filtering occurs in memory. This matches the existing app's personal-workspace model. Large-team/high-volume workloads should add SQL-side pagination before scaling.

## Verification

```sh
corepack pnpm typecheck
corepack pnpm test --maxWorkers=2
```

37 tests currently cover HTTP commands, domain completion/reopening, typed records and conflicts, PostgreSQL migrations/ownership, private image policies and existing SQL verification scripts. Tests use isolated PGlite and synthetic records, never production data. Container configuration is supplied; a container build has not been verified in this environment.
