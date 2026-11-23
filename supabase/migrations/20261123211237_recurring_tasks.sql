begin;
set local lock_timeout='5s';
create table public.task_recurrences (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 title text not null check(length(btrim(title)) between 1 and 300),
 description text not null default '' check(length(description)<=10000),
 project_id uuid,
 tags text[] not null default '{}' check(cardinality(tags)<=30),
 conditions text[] not null default '{}' check(cardinality(conditions)<=1000),
 rule jsonb not null check(jsonb_typeof(rule)='object' and rule->>'frequency' in ('daily','weekly','monthly') and (rule->>'interval')::int between 1 and 12),
 active boolean not null default true,
 skipped_on date[] not null default '{}' check(cardinality(skipped_on)<=10000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(owner_id,id),
 foreign key(owner_id,project_id) references public.projects(owner_id,id)
);
create index task_recurrences_owner_project_idx on public.task_recurrences(owner_id,project_id);
alter table public.task_recurrences enable row level security;
revoke all on public.task_recurrences from public,anon,authenticated;
grant select,insert,update,delete on public.task_recurrences to authenticated,service_role;
create policy own_select on public.task_recurrences for select to authenticated using(owner_id=(select auth.uid()));
create policy own_insert on public.task_recurrences for insert to authenticated with check(owner_id=(select auth.uid()));
create policy own_update on public.task_recurrences for update to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy own_delete on public.task_recurrences for delete to authenticated using(owner_id=(select auth.uid()));
create trigger preserve_identity_and_touch before update on public.task_recurrences for each row execute function planner_private.preserve_identity_and_touch();
alter table public.tasks add column recurrence_id uuid, add column scheduled_on date,
 add constraint task_recurrence_pair check((recurrence_id is null)=(scheduled_on is null)),
 add constraint task_recurrence_owner_fk foreign key(owner_id,recurrence_id) references public.task_recurrences(owner_id,id);
create unique index task_recurrence_date_unique on public.tasks(owner_id,recurrence_id,scheduled_on) where recurrence_id is not null;
comment on table public.task_recurrences is 'Recurring task templates. Each date is an independent Task. Active controls future generation; skipped_on prevents deleted occurrences returning. Rule monthly day last follows calendar month ends; numeric days clamp in shorter months. Existing tasks retain their individual edits and completion.';
do $api$
declare definition text; anchor text;
begin
 definition:=pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
 anchor:=$a$when 'tasks' then keys:=array['id']; allowed:=array[$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected task write API';end if;
 definition:=replace(definition,anchor,anchor||'''recurrence_id'',''scheduled_on'',');
 anchor:=$a$when 'sleep_records' then$a$;
 if position(anchor in definition)=0 then raise exception 'Unexpected mutation API';end if;
 definition:=replace(definition,anchor,$a$when 'task_recurrences' then keys:=array['id']; allowed:=array['id','title','description','project_id','tags','conditions','rule','active','skipped_on','created_at','updated_at'];
 when 'sleep_records' then$a$);
 execute definition;
end $api$;
-- Preserve the currently deployed API's strict task wire format during rollout.
create or replace function public.planner_load_workspace_with_meals() returns jsonb language sql stable security invoker set search_path='' as $$
 select public.planner_load_workspace_with_ordering() || jsonb_build_object(
 'tasks',coalesce((select jsonb_agg(to_jsonb(t)-'recurrence_id'-'scheduled_on' order by id) from public.tasks t where owner_id=(select auth.uid())),'[]'::jsonb),
 'meals',coalesce((select jsonb_agg(to_jsonb(t) order by ate_at desc,id) from public.meals t where owner_id=(select auth.uid())),'[]'::jsonb));
$$;
create function public.planner_load_workspace_with_recurrences() returns jsonb language sql stable security invoker set search_path='' as $$
 select public.planner_load_workspace_with_meals() || jsonb_build_object(
 'tasks',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.tasks t where owner_id=(select auth.uid())),'[]'::jsonb),
 'task_recurrences',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.task_recurrences t where owner_id=(select auth.uid())),'[]'::jsonb));
$$;
revoke all on function public.planner_load_workspace_with_recurrences() from public,anon;
grant execute on function public.planner_load_workspace_with_recurrences() to authenticated,service_role;
do $backup$
declare definition text;
begin
 definition:=pg_get_functiondef('public.planner_export_backup_with_meals()'::regprocedure);
 execute replace(replace(definition,'public.planner_export_backup_with_meals()','public.planner_export_backup_with_recurrences()'),'public.planner_load_workspace_with_meals()','public.planner_load_workspace_with_recurrences()');
end $backup$;
revoke all on function public.planner_export_backup_with_recurrences() from public,anon;
grant execute on function public.planner_export_backup_with_recurrences() to authenticated,service_role;
notify pgrst,'reload schema';
commit;
