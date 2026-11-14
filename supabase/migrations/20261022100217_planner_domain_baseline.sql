-- Confirmed planner domain. Goal is intentionally deferred.
-- New Supabase project only. Execute atomically; no sample data is installed.
begin;

create schema if not exists planner_private;
revoke all on schema planner_private from public, anon, authenticated;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  title text not null check (btrim(title) <> ''),
  description text not null default '',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  project_id uuid,
  title text not null check (btrim(title) <> ''),
  description text not null default '',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, project_id) references public.projects(owner_id, id)
);

create table public.task_completion_conditions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  task_id uuid not null,
  description text not null check (btrim(description) <> ''),
  is_met boolean not null default false,
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, task_id) references public.tasks(owner_id, id) on delete cascade
);

create table public.thoughts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  title text not null default '',
  content text not null check (btrim(content) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id)
);

create table public.thought_task_links (
  owner_id uuid not null default auth.uid() references auth.users(id),
  thought_id uuid not null,
  task_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, thought_id, task_id),
  foreign key (owner_id, thought_id) references public.thoughts(owner_id, id) on delete cascade,
  foreign key (owner_id, task_id) references public.tasks(owner_id, id) on delete cascade
);

create table public.thought_project_links (
  owner_id uuid not null default auth.uid() references auth.users(id),
  thought_id uuid not null,
  project_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, thought_id, project_id),
  foreign key (owner_id, thought_id) references public.thoughts(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade
);

create table public.habits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  title text not null check (btrim(title) <> ''),
  description text not null default '',
  timezone text not null default 'Asia/Kuala_Lumpur',
  starts_on date not null default ((now() at time zone 'Asia/Kuala_Lumpur')::date),
  ends_on date,
  iso_weekdays smallint[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  check (ends_on is null or ends_on >= starts_on),
  check (
    array_ndims(iso_weekdays) = 1
    and cardinality(iso_weekdays) between 1 and 7
    and iso_weekdays <@ array[1,2,3,4,5,6,7]::smallint[]
    and array_position(iso_weekdays, null) is null
  )
);

create table public.habit_occurrences (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  habit_id uuid not null,
  scheduled_on date not null,
  planned_on date not null,
  timezone text not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, id, habit_id),
  unique (owner_id, habit_id, scheduled_on),
  foreign key (owner_id, habit_id) references public.habits(owner_id, id)
);

create table public.habit_executions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  habit_id uuid not null,
  occurrence_id uuid not null,
  performed_on date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, occurrence_id),
  foreign key (owner_id, habit_id) references public.habits(owner_id, id),
  foreign key (owner_id, occurrence_id, habit_id)
    references public.habit_occurrences(owner_id, id, habit_id)
);

create table public.time_blocks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  title text not null default '',
  description text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Asia/Kuala_Lumpur',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  check (ends_at > starts_at)
);

create table public.time_block_tasks (
  owner_id uuid not null default auth.uid() references auth.users(id),
  time_block_id uuid not null,
  task_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, time_block_id, task_id),
  foreign key (owner_id, time_block_id) references public.time_blocks(owner_id, id) on delete cascade,
  foreign key (owner_id, task_id) references public.tasks(owner_id, id) on delete cascade
);

create table public.time_block_habit_occurrences (
  owner_id uuid not null default auth.uid() references auth.users(id),
  time_block_id uuid not null,
  occurrence_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, time_block_id, occurrence_id),
  foreign key (owner_id, time_block_id) references public.time_blocks(owner_id, id) on delete cascade,
  foreign key (owner_id, occurrence_id) references public.habit_occurrences(owner_id, id) on delete cascade
);

-- Every referencing direction and every RLS owner predicate has an index.
create index tasks_project_idx on public.tasks(owner_id, project_id);
create index conditions_task_idx on public.task_completion_conditions(owner_id, task_id, position);
create index thought_task_target_idx on public.thought_task_links(owner_id, task_id);
create index thought_project_target_idx on public.thought_project_links(owner_id, project_id);
create index occurrences_planned_idx on public.habit_occurrences(owner_id, planned_on);
create index executions_habit_idx on public.habit_executions(owner_id, habit_id, performed_on);
create index executions_occurrence_habit_idx on public.habit_executions(owner_id, occurrence_id, habit_id);
create index time_blocks_start_idx on public.time_blocks(owner_id, starts_at);
create index block_tasks_task_idx on public.time_block_tasks(owner_id, task_id);
create index block_habits_occurrence_idx on public.time_block_habit_occurrences(owner_id, occurrence_id);

create function planner_private.preserve_identity_and_touch()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id or new.id is distinct from old.id then
    raise exception 'Record identity and owner cannot be changed' using errcode = '23514';
  end if;
  new.created_at := old.created_at;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create function planner_private.guard_project_completion()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.completed_at is not null and exists (
    select 1 from public.tasks t
    where t.owner_id = new.owner_id and t.project_id = new.id and t.completed_at is null
  ) then
    raise exception 'Complete all project tasks before manually completing the project' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function planner_private.guard_task_completion()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare previous_project uuid;
begin
  if tg_op = 'UPDATE' then previous_project := old.project_id; end if;
  -- Serialize child mutations with manual project completion, in a stable order.
  perform p.id from public.projects p
    where p.owner_id = new.owner_id and p.id in (new.project_id, previous_project)
    order by p.id for update;
  if new.completed_at is not null and exists (
    select 1 from public.task_completion_conditions c
    where c.owner_id = new.owner_id and c.task_id = new.id and not c.is_met
  ) then
    raise exception 'Meet all completion conditions before manually completing the task' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function planner_private.reopen_project_for_task()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.project_id is not null and new.completed_at is null then
    update public.projects set completed_at = null
    where owner_id = new.owner_id and id = new.project_id and completed_at is not null;
  end if;
  return new;
end;
$$;

create function planner_private.lock_condition_task()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform t.id from public.tasks t where t.owner_id = old.owner_id and t.id = old.task_id for update;
    return old;
  end if;
  perform t.id from public.tasks t where t.owner_id = new.owner_id and t.id = new.task_id for update;
  return new;
end;
$$;

create function planner_private.reopen_task_for_condition()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not new.is_met then
    update public.tasks set completed_at = null
    where owner_id = new.owner_id and id = new.task_id and completed_at is not null;
  end if;
  -- Meeting/deleting conditions never auto-completes a task or project.
  return new;
end;
$$;

create function planner_private.validate_timezone()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception 'Unknown IANA timezone: %', new.timezone using errcode = '23514';
  end if;
  return new;
end;
$$;

create function planner_private.normalize_habit_weekdays()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.iso_weekdays := array(select distinct d from unnest(new.iso_weekdays) d order by d);
  return new;
end;
$$;

create function planner_private.guard_habit_occurrence()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare h public.habits%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.habit_id is distinct from old.habit_id or new.scheduled_on is distinct from old.scheduled_on
      or new.timezone is distinct from old.timezone then
      raise exception 'Keep the original habit, scheduled date and timezone; reschedule planned_on only' using errcode = '23514';
    end if;
    return new;
  end if;
  select * into h from public.habits where owner_id = new.owner_id and id = new.habit_id for share;
  if not found then
    raise exception 'Habit not found for this owner' using errcode = '23503';
  end if;
  if new.scheduled_on < h.starts_on or (h.ends_on is not null and new.scheduled_on > h.ends_on)
    or not (extract(isodow from new.scheduled_on)::smallint = any(h.iso_weekdays)) then
    raise exception 'Original occurrence date must match the habit active dates and fixed weekdays' using errcode = '23514';
  end if;
  new.planned_on := coalesce(new.planned_on, new.scheduled_on);
  new.timezone := h.timezone;
  return new;
end;
$$;

create function planner_private.preserve_execution_assignment()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.habit_id is distinct from old.habit_id or new.occurrence_id is distinct from old.occurrence_id then
    raise exception 'One execution stays assigned to one habit occurrence' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_project_completion before insert or update on public.projects
for each row execute function planner_private.guard_project_completion();
create trigger guard_task_completion before insert or update on public.tasks
for each row execute function planner_private.guard_task_completion();
create trigger reopen_project_for_task after insert or update on public.tasks
for each row execute function planner_private.reopen_project_for_task();
create trigger lock_condition_task before insert or update or delete on public.task_completion_conditions
for each row execute function planner_private.lock_condition_task();
create trigger reopen_task_for_condition after insert or update on public.task_completion_conditions
for each row execute function planner_private.reopen_task_for_condition();
create trigger validate_habit_timezone before insert or update on public.habits
for each row execute function planner_private.validate_timezone();
create trigger normalize_habit_weekdays before insert or update on public.habits
for each row execute function planner_private.normalize_habit_weekdays();
create trigger guard_habit_occurrence before insert or update on public.habit_occurrences
for each row execute function planner_private.guard_habit_occurrence();
create trigger preserve_execution_assignment before update on public.habit_executions
for each row execute function planner_private.preserve_execution_assignment();
create trigger validate_block_timezone before insert or update on public.time_blocks
for each row execute function planner_private.validate_timezone();

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'projects', 'tasks', 'task_completion_conditions', 'thoughts', 'thought_task_links',
    'thought_project_links', 'habits', 'habit_occurrences', 'habit_executions', 'time_blocks',
    'time_block_tasks', 'time_block_habit_occurrences'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to authenticated, service_role', table_name);
    execute format(
      'create policy owner_access on public.%I for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id)',
      table_name
    );
    if table_name not in ('thought_task_links', 'thought_project_links', 'time_block_tasks', 'time_block_habit_occurrences') then
      execute format(
        'create trigger preserve_identity_and_touch before update on public.%I for each row execute function planner_private.preserve_identity_and_touch()',
        table_name
      );
    end if;
  end loop;
end;
$$;

-- No SECURITY DEFINER function and no public-callable privileged RPC.
revoke all on all functions in schema planner_private from public, anon, authenticated;

create view public.habit_occurrence_status with (security_invoker = true) as
select o.id, o.owner_id, o.habit_id, o.scheduled_on, o.planned_on, o.timezone, o.note,
  e.id as execution_id, e.performed_on, e.created_at as completion_recorded_at,
  (e.id is not null) as is_completed,
  case when e.id is not null then 'completed'
       when o.planned_on < (now() at time zone o.timezone)::date then 'missed'
       else 'planned' end as state
from public.habit_occurrences o
left join public.habit_executions e on e.owner_id = o.owner_id and e.occurrence_id = o.id;
revoke all on public.habit_occurrence_status from public, anon, authenticated;
grant select on public.habit_occurrence_status to authenticated, service_role;

comment on table public.projects is 'All tasks must be completed before explicit manual project completion; empty projects may be manually completed.';
comment on table public.tasks is 'Optional single project, zero or more time blocks and completion conditions; manual completion only.';
comment on table public.thoughts is 'Ideas and factual records; conversion preserves the source and uses many-to-many provenance links.';
comment on table public.habits is 'Fixed ISO weekdays (1=Monday, 7=Sunday); independent from tasks. Existing occurrences preserve history.';
comment on table public.habit_occurrences is 'Original scheduled date is immutable; planned_on moves this occurrence only. No automatic rollover.';
comment on table public.habit_executions is 'One actual execution belongs to one occurrence; performed_on preserves the actual date for late completion/backfill.';
comment on table public.time_blocks is 'Planning only, including standalone activities. No completion state. Duration is ends_at minus starts_at.';
comment on table public.time_block_habit_occurrences is 'Time blocks associate with a specific planned habit occurrence, which identifies its habit.';
comment on view public.habit_occurrence_status is 'RLS-respecting derived state. Missing occurrence generation/automatic scheduling is not a database background job.';

commit;
