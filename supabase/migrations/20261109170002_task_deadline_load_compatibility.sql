-- Older open clients strictly validate Task JSON, so keep their response shape stable.
begin;
do $migration$
declare
  definition text := pg_get_functiondef('public.planner_load_workspace()'::regprocedure);
  anchor text := $$'tasks', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.tasks$$;
  replacement text := $$'tasks', coalesce((select jsonb_agg((to_jsonb(t) - 'deadline') order by id) from public.tasks$$;
begin
  if position(anchor in definition)=0 then
    raise exception 'Unexpected Task load API; review this migration';
  end if;
  -- Copy the single-snapshot, owner-filtered SECURITY INVOKER loader for new clients.
  execute replace(definition, 'public.planner_load_workspace()', 'public.planner_load_workspace_with_deadlines()');
  execute replace(definition, anchor, replacement);
end $migration$;
revoke all on function public.planner_load_workspace_with_deadlines() from public, anon;
grant execute on function public.planner_load_workspace_with_deadlines() to authenticated;
notify pgrst, 'reload schema';
commit;
