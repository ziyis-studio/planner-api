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

The frontend remains independently built and deployed from `ONE`. Cloud mode sends all workspace reads/writes, profile operations and images to this API. Supabase Auth remains the identity provider; email/OAuth/session refresh and the existing username-login Edge Function are authentication paths, not direct business-data access. Optional local/demo mode remains offline and never acts as a fallback for API failures. Weather is an external public-data integration and remains independent of workspace persistence.

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

`task.create.input.initialStage` optionally accepts `todo`, `progress`, `hold`,
or `done`; `project.create.input.initialStage` accepts `progress`, `hold`, or
`done`. The initial stage takes precedence over `workStatus` when supplied and
sets the existing work/start/completion fields in the same transaction as
creation. Omitting it preserves the previous behavior. A new Done task cannot
have unmet completion conditions: the command rejects without creating a task
or any conditions. These options require no database migration.

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

Automated tests cover HTTP commands, domain completion/reopening, typed records and conflicts, PostgreSQL migrations/ownership, private image policies, activity logs, backup recovery and existing SQL verification scripts. Tests use isolated PGlite and synthetic records, never production-user data. Container configuration is supplied; a container build has not been verified in this environment.

## Hosting status

GitHub: https://github.com/ziyis-studio/planner-api. Vercel project: `planner-api` (`prj_9vYHGssHhuc2ww3RxDi2MmFpuh2B`). Production alias: `https://planner-api-ziyis-studio.vercel.app`. On November 15, 2026, the user approved preview-only Vercel Authentication. Production API calls now use Supabase bearer-token authentication and RLS; preview deployments retain Vercel protection. The frontend production cutover is complete at https://planner-core-puce.vercel.app. API health and the frontend bundled API configuration were verified; authenticated real-user writes were not exercised in production. The additive note-database migration has been applied and anonymous RPC execution is denied.

### Focus records and recovery

Completed Pomodoro sessions may reference an owned task; the task title is also
kept as a snapshot. A completion and its actual Schedule block/task link are
committed atomically. Retries reuse the session identity; task completion remains
manual. Deleting a task or a recording's block preserves the completion history.

DELETE commands write a compact inverse patch into owner-scoped
`planner_recovery` within the same transaction. `GET /v1/recovery?offset=0`
lists 50 active entries; `POST /v1/recovery/:id/restore` restores removed rows and
unchanged detached references. Conflicting later edits abort the entire restore.
`DELETE /v1/recovery/:id` permanently removes that recovery entry.

`GET /v1/backup` takes one owner-serialized snapshot of the workspace, complete
focus history and recovery records. `POST /v1/backup` accepts
`{ backup, asCopy?: boolean }`, validates the relation graph and adds missing
identities without replacing current rows. Foreign-account and explicit-copy
imports deterministically remap entity, link and database-property identities;
repeating the same import is idempotent. Workspace writes, session imports and
recovery imports share one transaction. Metadata requests are capped at 3.5 MB;
the browser exports/restores immutable private image files separately with
signature and content-hash checks. Neither route accepts owner credentials or
uses an elevated Supabase key.

Migrations `20261117112959`, `20261117113951` and `20261117114416` are applied to
planner-core. `tests/focus-recovery-sql.test.ts` verifies recording links, recovery,
atomic rollback, portable import and RLS against the complete migration chain.

### Tags graph

`POST /v1/tag-graph` reads the authenticated owner's snapshot and returns `{nodes,links,availableTags,totalMatches,shownItems,truncated}`. The body accepts `q`, `kind` (`all`, `task`, `project`, `note`), `tag`, `includeCompleted` (default true) and `includeUntagged` (default false). Items link to direct tags, tasks also link to their project and inherited project tags, and displayed note references are retained. Unused catalog tags are included. Graphs are bounded at 600 nodes without dangling edges and disclose truncation so filters can narrow large datasets.

`POST /v1/sample/tag-graph` accepts `{workspace,query}` and runs the same read logic against a bounded caller-supplied snapshot, without account access. Existing `tag.create` and `tag.rename` commands manage catalog and record associations; renaming to an existing tag merges connections, and `to: null` removes the tag while keeping records. No schema migration is needed.

`POST /v1/tag-options` accepts `{q,selected}` and returns up to 50 sorted tag choices, complete usage counts, normalized selected names, and a server-validated creation candidate. Choices combine the catalog, direct tags, and inherited project tags. Searching never creates a tag; the existing `tag.create` command performs creation.

`POST /v1/tag-list` accepts the graph filters plus `offset`, `limit` (up to 100), and `onlyUntagged`. It returns paginated tag groups with task/project/note counts, or complete matching records when a tag or the untagged group is selected. List counts and pagination are independent of the 600-node graph bound. Both reads have stateless `/v1/sample/...` equivalents accepting `{workspace,query}` and never access an account database.

### Task and project logs

`GET /v1/activity?kind=task|project&id=<uuid>` returns `{items,next,linkedBlocks}` with up to
50 entries, newest first. Supply both `beforeAt` and `beforeId` from `next` to
page older records. Project feeds include logs of tasks currently assigned to
that project. Each entry retains `target_kind` and `target_id` for its source.

`linkedBlocks` is derived from current task/block associations on the server and includes dates, duration, related tasks, and past/current/upcoming state. Shared blocks appear once in project logs; moving or unlinking a block is reflected on the next fetch. `/v1/sample/activity-feed` returns the same shape from a bounded caller-supplied workspace and manual log entries without accessing an account database.

`POST /v1/activity` accepts `{id,kind,targetId,body}`. The caller supplies a stable
entry UUID so retries are idempotent; reusing an identity with different content
returns 409. Bodies are plain text, trimmed and limited to 10,000 characters.
The target must belong to the authenticated owner. No owner/author field is
accepted. These private logs are append-only; no edit/delete route is exposed.

The `entity_logs` table has owner RLS and owner-scoped target foreign keys. Logs
retain their original target identity when an item enters Trash, so restoring
the item restores its feed. Orphaned history stays private and is included in
backups. Project rollup follows current task membership. Log comments do not
modify task/project revisions. Existing note links use ordinary guarded
`note.save` commands, preserving all other note targets.

Migration `20261119075257_task_project_activity.sql` also adds activity to the
single-transaction backup snapshot and import. Existing exports without logs
remain valid; copied imports deterministically remap entry/target identities.
The production migration and RLS/rollup/recovery/backup behavior were verified
using synthetic records inside a rolled-back transaction.


### Enhance ONE API boundaries

ONE now ships static frontend assets with a declarative `/api/:path*` rewrite.
Add the exact frontend origin to `API_ALLOWED_ORIGINS` before deploying it.
Apply the two additive `enhance_one_ordering_and_attachments` and
`attachments_image_uploads` migrations, deploy this backend, then deploy ONE.
Legacy workspace/backup RPCs retain their previous shapes during rollout; this
backend uses `planner_load_workspace_with_ordering` and
`planner_export_backup_with_ordering`.

- `task.move` and `project.move`: one atomic status transition with an opaque
  `expectedUpdatedAt`. Optional `beforeId` and full `items` revisions move and
  place a card in the same transaction. Completion gates remain authoritative.
- `task.reorder` / `project.reorder`: a complete revision-checked list of
  `{id,updatedAt}`. Global `listPosition` survives reload and backup; old backups
  remain valid. Existing `project.reorderTasks` is still supported.
- `GET /v1/sessions?day=YYYY-MM-DD&zone=...` and `POST /v1/sessions` replace
  frontend table access. POST accepts `{timezone,records}` with camel-case
  session fields; owner identity always comes from the authenticated token.
- `POST /v1/files` uploads PDF, text, Markdown, CSV, ZIP and modern Office files
  up to 3 MiB. `GET /v1/files/:key` serves owned downloads as attachments.
  `POST /v1/files/:key` and `POST /v1/images/:key` restore immutable identities,
  accepting existing content only when bytes match. All file routes require auth.
- `POST /v1/auth/username` forwards bounded credentials to the existing
  rate-limited username Edge Function. Email authentication still uses Supabase Auth.
- `GET /v1/weather?zone=...` returns current weather for supported zones,
  cached for five minutes. This public-data route uses a fixed upstream origin.
- `POST /v1/insights` accepts `{kind:"sleep"|"habits",from,to,zone}` for up to
  366 calendar dates. It derives statistics from the caller's workspace without
  writing records. Habit counts follow planned dates, including moved and
  unmaterialized occurrences. Streaks skip rest days and leave unfinished today
  open. Sleep groups by wake-up date; rhythm uses the longest period each day
  and uses circular 24-hour means for bedtime and wake-up, including midnight and noon. Opposing clock times have no single usual window. Missing days remain missing.
- Public `/v1/sample` and its `/restore`, `/import`, `/sessions`, `/activity`, `/activity-feed`, `/insights`
  operations run bounded stateless sample transactions. They never authenticate
  an account or access its database; sample data is supplied by the caller.

No elevated credentials are required. Private attachments use the caller's JWT,
owner-only Storage RLS, validated signatures and immutable names. New storage
policies include a restrictive owner guard even if another broad policy exists.

Meal records, API fields, private photo locations and the external-analysis update contract are documented in [docs/meals.md](docs/meals.md).
