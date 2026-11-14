-- Optional project identity; existing records keep the default Folder presentation.
begin;
alter table public.projects add column icon text
  constraint projects_icon_check check (icon in ('folder','home','briefcase','code','palette','book','graduation','heart','plane','fitness','leaf','sparkles'));

-- Extend only the existing invoker API allowlist; retain its ownership/revision checks.
do $$
declare
  definition text := pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
  previous text := 'when ''projects'' then keys:=array[''id'']; allowed:=array[''id'',''title'',''description'',''completed_at'',''created_at'',''updated_at''];';
  revised text := 'when ''projects'' then keys:=array[''id'']; allowed:=array[''id'',''title'',''description'',''icon'',''completed_at'',''created_at'',''updated_at''];';
begin
  if position(previous in definition) = 0 then
    raise exception 'Unexpected Project API allowlist; migration requires review';
  end if;
  execute replace(definition, previous, revised);
end $$;
notify pgrst, 'reload schema';
commit;
