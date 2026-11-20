# Meal records and external nutrition analysis

`public.meals` stores one row per meal. It uses the existing personal ownership boundary (`owner_id`, RLS), optimistic revisions and private image storage. The ONE frontend saves through Planner API. No AI provider, key, job or automatic nutritional estimate is configured.

## Data contract

| Column | Meaning |
| --- | --- |
| `id`, `owner_id` | Stable meal identity and account owner |
| `title`, `description` | Optional name and free-text food, portions or ingredients; a meal needs text or a photo |
| `kind` | `breakfast`, `lunch`, `dinner`, `snack`, `other` |
| `ate_at`, `timezone` | Actual timestamp and recording timezone; the workspace timezone determines the displayed day |
| `photos` | JSON array of `{ "ref": "planner-image://<uuid>.jpg", "alt": "..." }`, at most 6 |
| `calories` | kcal for the **entire meal** |
| `protein`, `carbs`, `fat`, `fiber` | Grams for the **entire meal** |
| `nutrition_source` | `manual` or `external` |
| `created_at`, `updated_at` | Identity and server revision; updates touch the revision automatically |

Each nutrient is independently nullable. NULL means unknown; 0 is a recorded zero. Values are non-negative, at most 100000 and stored to two decimal places. Daily totals sum only entered values and report coverage independently for each nutrient. They never convert unknown values to recorded zero or infer calories from macros.

Photos live in the existing private `planner-images` bucket at `<owner_id>/<ref without planner-image://>`. Account-authenticated `GET /v1/images/<filename>` returns the image through Planner API. A server-side analyzer can use scoped Storage access. Do not put server credentials or permanent public image URLs into meal rows. Camera photos accepted by ONE (JPEG/PNG/WebP, up to 20 MB input) are resized to at most 2000 pixels on the longest edge and uploaded as JPEG under 3 MB. Card cropping only affects display; the stored photo retains the whole resized frame.

## Connect an external analyzer

Read the text, photos, owner and exact `updated_at` revision. After analyzing, write just the known nutrient values and mark their source. Bind parameters, including the same owner and revision that were read:

```sql
update public.meals
set calories = :calories_kcal,
    protein = :protein_g,
    carbs = :carbs_g,
    fat = :fat_g,
    fiber = :fiber_g,
    nutrition_source = 'external'
where id = :meal_id
  and owner_id = :owner_id
  and updated_at = :revision_read
returning id, updated_at;
```

Zero returned rows means the meal changed while analysis ran. Re-read it before retrying so an older analysis cannot overwrite a changed description, photo or manual value. Keep unknown values NULL. The existing update trigger advances `updated_at`; active editors reject stale saves. Use **Refresh meals** in ONE to load results written externally.

## API and recovery

- `POST /v1/commands`: `meal.save` / `meal.delete`. Updating or deleting requires the current `expectedUpdatedAt`. A save uses camelCase fields corresponding to the table above; timestamps must be in the past or present.
- `GET /v1/meals?date=YYYY-MM-DD&zone=Asia%2FKuala_Lumpur`: account-isolated day's records, per-nutrient totals and coverage, and seven days of recorded energy.
- `POST /v1/sample/meals`: the same read calculation for an explicit stateless sample workspace.
- The new `planner_load_workspace_with_meals()` and `planner_export_backup_with_meals()` RPCs extend the prior RPCs without changing their wire shape. Older backups default to no meals.
- Meal deletion uses the shared Trash/Undo transaction. Restore and complete backups retain nutrition values and private photo references/files. Removing a photo from a meal does not erase an image needed by an unsent draft or Trash entry.

Validation covers nullable versus zero values, timezone boundaries, stale external edits, database constraints, account isolation, legacy RPCs/backups, recovery, and the browser upload flow against isolated Postgres and private file transport.
