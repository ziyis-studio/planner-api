begin;

-- Optional on older app backups; database rows always have a nonnegative position.
alter table public.tasks add column project_position integer not null default 0
  constraint tasks_project_position_check check (project_position >= 0);

-- Retain the established invoker API, ownership policies, row locks and revision tokens.
do $$
declare
  definition text := pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
  previous text := 'when ''tasks'' then keys:=array[''id'']; allowed:=array[''id'',''title'',''description'',''project_id'',''completed_at'',''created_at'',''updated_at''];';
  revised text := 'when ''tasks'' then keys:=array[''id'']; allowed:=array[''id'',''title'',''description'',''project_id'',''project_position'',''completed_at'',''created_at'',''updated_at''];';
begin
  if position(previous in definition) = 0 then
    raise exception 'Unexpected Task API allowlist; migration requires review';
  end if;
  execute replace(definition, previous, revised);
end $$;

notify pgrst, 'reload schema';
commit;
