-- Explicit Task progress, independent from timed arrangements and completion gates.
begin;
set local lock_timeout = '5s';
alter table public.tasks add column started_at timestamptz;
comment on column public.tasks.started_at is 'Explicitly marked to continue. completed_at still records separately gated manual completion.';
do $migration$
declare
  definition text;
  anchor text := $$'tasks', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.tasks$$;
  replacement text := $$'tasks', coalesce((select jsonb_agg((to_jsonb(t) - 'started_at') order by id) from public.tasks$$;
  legacy_anchor text := $$jsonb_agg((to_jsonb(t) - 'deadline') order by id) from public.tasks$$;
  legacy_replacement text := $$jsonb_agg((to_jsonb(t) - 'deadline' - 'started_at') order by id) from public.tasks$$;
  write_anchor text := $$when 'tasks' then keys:=array['id']; allowed:=array['id','title','description','project_id','project_position','deadline','completed_at','created_at','updated_at'];$$;
  write_replacement text := $$when 'tasks' then keys:=array['id']; allowed:=array['id','title','description','project_id','project_position','deadline','started_at','completed_at','created_at','updated_at'];$$;
begin
  definition := pg_get_functiondef('public.planner_load_workspace_with_deadlines()'::regprocedure);
  if position(anchor in definition)=0 then raise exception 'Unexpected deadline loader'; end if;
  execute replace(definition, 'public.planner_load_workspace_with_deadlines()', 'public.planner_load_workspace_with_task_progress()');
  execute replace(definition, anchor, replacement);
  definition := pg_get_functiondef('public.planner_load_workspace()'::regprocedure);
  if position(legacy_anchor in definition)=0 then raise exception 'Unexpected legacy loader'; end if;
  execute replace(definition, legacy_anchor, legacy_replacement);
  definition := pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
  if position(write_anchor in definition)=0 then raise exception 'Unexpected Task write API'; end if;
  execute replace(definition, write_anchor, write_replacement);
end $migration$;
revoke all on function public.planner_load_workspace_with_task_progress() from public, anon;
grant execute on function public.planner_load_workspace_with_task_progress() to authenticated;
notify pgrst, 'reload schema';
commit;
