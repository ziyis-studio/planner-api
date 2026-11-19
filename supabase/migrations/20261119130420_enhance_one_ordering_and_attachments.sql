begin;
set local lock_timeout = '5s';
alter table public.projects add column list_position integer not null default 0 check(list_position >= 0);
alter table public.tasks add column list_position integer not null default 0 check(list_position >= 0);
with positions as (select id, row_number() over(partition by owner_id order by created_at,id)-1 as pos from public.projects)
update public.projects p set list_position=positions.pos from positions where p.id=positions.id;
with positions as (select id, row_number() over(partition by owner_id order by created_at,id)-1 as pos from public.tasks)
update public.tasks t set list_position=positions.pos from positions where t.id=positions.id;
do $migration$
declare definition text; tab text; anchor text;
begin
  definition:=pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
  foreach tab in array array['tasks','projects'] loop
    anchor:=format('when %L then keys:=array[''id'']; allowed:=array[',tab);
    if position(anchor in definition)=0 then raise exception 'Unexpected write API'; end if;
    definition:=replace(definition,anchor,anchor || $column$'list_position',$column$);
  end loop;
  execute definition;
end $migration$;
-- Preserve the old wire shape during independent frontend/backend rollouts.
do $compat$
declare item record; definition text;
begin
  for item in select oid from pg_proc where pronamespace='public'::regnamespace
    and proname like 'planner_load_workspace%' loop
    definition:=pg_get_functiondef(item.oid);
    execute replace(definition,'to_jsonb(t)', $expr$(to_jsonb(t) - 'list_position')$expr$);
  end loop;
end $compat$;
create function public.planner_load_workspace_with_ordering() returns jsonb language sql stable security invoker set search_path='' as $$
 select public.planner_load_workspace_with_databases() || jsonb_build_object(
  'projects',coalesce((select jsonb_agg(to_jsonb(t) order by list_position,created_at,id) from public.projects t where owner_id=(select auth.uid())),'[]'::jsonb),
  'tasks',coalesce((select jsonb_agg(to_jsonb(t) order by list_position,created_at,id) from public.tasks t where owner_id=(select auth.uid())),'[]'::jsonb));
$$;
revoke all on function public.planner_load_workspace_with_ordering() from public,anon;
grant execute on function public.planner_load_workspace_with_ordering() to authenticated;
do $backup$
declare definition text;
begin
 definition:=pg_get_functiondef('public.planner_export_backup()'::regprocedure);
 execute replace(replace(definition,'public.planner_export_backup()', 'public.planner_export_backup_with_ordering()'),
   'public.planner_load_workspace_with_databases()', 'public.planner_load_workspace_with_ordering()');
end $backup$;
revoke all on function public.planner_export_backup_with_ordering() from public,anon;
grant execute on function public.planner_export_backup_with_ordering() to authenticated;
notify pgrst,'reload schema';
commit;
