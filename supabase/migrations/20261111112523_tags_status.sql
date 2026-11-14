begin;
set local lock_timeout='5s';
alter table public.notes add column tags text[] not null default '{}' check(cardinality(tags)<=30);
alter table public.tasks add column tags text[] not null default '{}' check(cardinality(tags)<=30), add column work_status text not null default 'active' check(work_status in ('active','on_hold'));
alter table public.projects add column tags text[] not null default '{}' check(cardinality(tags)<=30), add column work_status text not null default 'active' check(work_status in ('active','on_hold'));
do $migration$
declare definition text; loader text; tab text; anchor text;
begin
 definition:=pg_get_functiondef('public.planner_load_workspace_with_habit_icons()'::regprocedure);
 execute replace(definition,'public.planner_load_workspace_with_habit_icons()','public.planner_load_workspace_with_tags()');
 foreach loader in array array['planner_load_workspace','planner_load_workspace_with_deadlines','planner_load_workspace_with_task_progress','planner_load_workspace_with_habit_icons'] loop
  definition:=pg_get_functiondef(('public.'||loader||'()')::regprocedure);
  execute replace(definition,'to_jsonb(t)', $$ (to_jsonb(t) - 'tags' - 'work_status') $$);
 end loop;
 definition:=pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
 foreach tab in array array['notes','tasks','projects'] loop
  anchor:=format('when %L then keys:=array[''id'']; allowed:=array[',tab);
  if position(anchor in definition)=0 then raise exception 'Unexpected write API'; end if;
  definition:=replace(definition,anchor,anchor||case when tab='notes' then '''tags'',' else '''tags'',''work_status'',' end);
 end loop;
 execute definition;
end $migration$;
revoke all on function public.planner_load_workspace_with_tags() from public,anon;
grant execute on function public.planner_load_workspace_with_tags() to authenticated;
notify pgrst,'reload schema';
commit;
