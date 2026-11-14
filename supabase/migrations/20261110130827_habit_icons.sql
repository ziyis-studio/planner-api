-- Optional Habit identity; preserve strict older loader response shapes and owner/revision checks.
begin;
set local lock_timeout = '5s';
alter table public.habits add column icon text
  constraint habits_icon_check check (icon is null or icon in
    ('repeat','water','moon','sun','book','fitness','walk','heart','leaf','coffee','journal','music'));
comment on column public.habits.icon is 'Optional supported Habit symbol; null retains the default routine symbol.';
do $migration$
declare
  definition text;
  loader_name text;
  anchor text := $$'habits', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.habits$$;
  replacement text := $$'habits', coalesce((select jsonb_agg((to_jsonb(t) - 'icon') order by id) from public.habits$$;
  write_anchor text := $$when 'habits' then keys:=array['id']; allowed:=array['id','title','description','timezone','starts_on','ends_on','iso_weekdays','created_at','updated_at'];$$;
  write_replacement text := $$when 'habits' then keys:=array['id']; allowed:=array['id','icon','title','description','timezone','starts_on','ends_on','iso_weekdays','created_at','updated_at'];$$;
begin
  definition := pg_get_functiondef('public.planner_load_workspace_with_task_progress()'::regprocedure);
  if position(anchor in definition)=0 then raise exception 'Unexpected Habit loader'; end if;
  execute replace(definition, 'public.planner_load_workspace_with_task_progress()', 'public.planner_load_workspace_with_habit_icons()');
  foreach loader_name in array array['planner_load_workspace','planner_load_workspace_with_deadlines','planner_load_workspace_with_task_progress'] loop
    definition := pg_get_functiondef(('public.' || loader_name || '()')::regprocedure);
    if position(anchor in definition)=0 then raise exception 'Unexpected legacy Habit loader: %', loader_name; end if;
    execute replace(definition, anchor, replacement);
  end loop;
  definition := pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
  if position(write_anchor in definition)=0 then raise exception 'Unexpected Habit write API'; end if;
  execute replace(definition, write_anchor, write_replacement);
end $migration$;
revoke all on function public.planner_load_workspace_with_habit_icons() from public, anon;
grant execute on function public.planner_load_workspace_with_habit_icons() to authenticated;
notify pgrst, 'reload schema';
commit;
