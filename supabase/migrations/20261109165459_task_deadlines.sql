-- Optional calendar deadlines do not arrange time or record completion.
begin;
set local lock_timeout = '5s';
alter table public.tasks add column deadline date;
comment on column public.tasks.deadline is
  'Optional calendar deadline; compared in the workspace zone, independent of time arrangements and manual completion.';

-- Retain all current ownership, revision and completion behavior in the API.
do $migration$
declare
  definition text;
  anchor text := $$when 'tasks' then keys:=array['id']; allowed:=array['id','title','description','project_id','project_position','completed_at','created_at','updated_at'];$$;
  replacement text := $$when 'tasks' then keys:=array['id']; allowed:=array['id','title','description','project_id','project_position','deadline','completed_at','created_at','updated_at'];$$;
begin
  definition := pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
  if position(anchor in definition)=0 then
    raise exception 'Unexpected Task mutation API; review this migration';
  end if;
  execute replace(definition,anchor,replacement);
end $migration$;
-- planner_load_workspace already selects complete Task rows as JSON.
notify pgrst, 'reload schema';
commit;
