-- Apply only this additive migration to the already-created project.
-- All operations run as the authenticated caller and retain the baseline RLS/trigger gates.
begin;

create function public.planner_load_workspace()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'projects', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.projects t where owner_id = (select auth.uid())), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.tasks t where owner_id = (select auth.uid())), '[]'::jsonb),
    'task_completion_conditions', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.task_completion_conditions t where owner_id = (select auth.uid())), '[]'::jsonb),
    'thoughts', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.thoughts t where owner_id = (select auth.uid())), '[]'::jsonb),
    'habits', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.habits t where owner_id = (select auth.uid())), '[]'::jsonb),
    'habit_occurrences', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.habit_occurrences t where owner_id = (select auth.uid())), '[]'::jsonb),
    'habit_executions', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.habit_executions t where owner_id = (select auth.uid())), '[]'::jsonb),
    'time_blocks', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.time_blocks t where owner_id = (select auth.uid())), '[]'::jsonb),
    'thought_task_links', coalesce((select jsonb_agg(to_jsonb(t) order by thought_id,task_id) from public.thought_task_links t where owner_id = (select auth.uid())), '[]'::jsonb),
    'thought_project_links', coalesce((select jsonb_agg(to_jsonb(t) order by thought_id,project_id) from public.thought_project_links t where owner_id = (select auth.uid())), '[]'::jsonb),
    'time_block_tasks', coalesce((select jsonb_agg(to_jsonb(t) order by time_block_id,task_id) from public.time_block_tasks t where owner_id = (select auth.uid())), '[]'::jsonb),
    'time_block_habit_occurrences', coalesce((select jsonb_agg(to_jsonb(t) order by time_block_id,occurrence_id) from public.time_block_habit_occurrences t where owner_id = (select auth.uid())), '[]'::jsonb)
  );
$$;

create function public.planner_apply_changes(changes jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  actor uuid := auth.uid();
  change jsonb;
  record_data jsonb;
  current_row jsonb;
  table_name text;
  operation text;
  keys text[];
  allowed text[];
  columns_sql text;
  select_sql text;
  update_sql text;
  filter_sql text;
  row_key jsonb;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if jsonb_typeof(changes) is distinct from 'array' then
    raise exception 'Expected an array of changes' using errcode='22023';
  end if;
  if jsonb_array_length(changes) > 5000 then
    raise exception 'Expected at most 5000 changes' using errcode='22023';
  end if;
  -- Serialize this app's transactions for an owner; row locks still protect REST edits.
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  -- Validate every revision BEFORE writes, since completion triggers may touch parents.
  for change in select value from jsonb_array_elements(changes) loop
    table_name := change->>'table'; operation := change->>'action'; record_data := change->'row';
    if operation not in ('insert','update','delete') or operation is null or jsonb_typeof(record_data) is distinct from 'object' then
      raise exception 'Invalid change' using errcode='22023';
    end if;
    case table_name
      when 'projects' then keys:=array['id']; allowed:=array['id','title','description','completed_at','created_at','updated_at'];
      when 'tasks' then keys:=array['id']; allowed:=array['id','title','description','project_id','completed_at','created_at','updated_at'];
      when 'task_completion_conditions' then keys:=array['id']; allowed:=array['id','task_id','description','is_met','position','created_at','updated_at'];
      when 'thoughts' then keys:=array['id']; allowed:=array['id','title','content','created_at','updated_at'];
      when 'habits' then keys:=array['id']; allowed:=array['id','title','description','timezone','starts_on','ends_on','iso_weekdays','created_at','updated_at'];
      when 'habit_occurrences' then keys:=array['id']; allowed:=array['id','habit_id','scheduled_on','planned_on','timezone','note','created_at','updated_at'];
      when 'habit_executions' then keys:=array['id']; allowed:=array['id','habit_id','occurrence_id','performed_on','note','created_at','updated_at'];
      when 'time_blocks' then keys:=array['id']; allowed:=array['id','title','description','starts_at','ends_at','timezone','created_at','updated_at'];
      when 'thought_task_links' then keys:=array['thought_id','task_id']; allowed:=keys;
      when 'thought_project_links' then keys:=array['thought_id','project_id']; allowed:=keys;
      when 'time_block_tasks' then keys:=array['time_block_id','task_id']; allowed:=keys;
      when 'time_block_habit_occurrences' then keys:=array['time_block_id','occurrence_id']; allowed:=keys;
      else raise exception 'Unsupported table' using errcode='22023';
    end case;
    if exists(select 1 from jsonb_object_keys(record_data) k where not k = any(allowed)) or
       exists(select 1 from unnest(keys) k where not record_data ? k or record_data->>k is null) then
      raise exception 'Unsupported fields or missing identity' using errcode='22023';
    end if;
    select jsonb_object_agg(k,record_data->k) into row_key from unnest(keys) k;
    select string_agg(format('t.%I=($2->>%L)::uuid',k,k),' and ') into filter_sql from unnest(keys) k;
    if operation <> 'insert' then
      execute format('select to_jsonb(t) from public.%I t where owner_id=$1 and %s for update', table_name,filter_sql)
        into current_row using actor,row_key;
      if current_row is null or ('id'=any(keys) and ((change->>'expectedUpdatedAt') is null or (current_row->>'updated_at')::timestamptz is distinct from (change->>'expectedUpdatedAt')::timestamptz)) then
        raise exception 'Record changed or is unavailable' using errcode='40001';
      end if;
    end if;
  end loop;

  for change in select value from jsonb_array_elements(changes) loop
    table_name:=change->>'table'; operation:=change->>'action'; record_data:=change->'row';
    keys:=case table_name when 'thought_task_links' then array['thought_id','task_id'] when 'thought_project_links' then array['thought_id','project_id'] when 'time_block_tasks' then array['time_block_id','task_id'] when 'time_block_habit_occurrences' then array['time_block_id','occurrence_id'] else array['id'] end;
    select jsonb_object_agg(k,record_data->k) into row_key from unnest(keys) k;
    select string_agg(format('t.%I=($2->>%L)::uuid',k,k),' and ') into filter_sql from unnest(keys) k;
    if operation='delete' then
      execute format('delete from public.%I t where owner_id=$1 and %s',table_name,filter_sql) using actor,row_key;
    elsif operation='insert' then
      record_data:=record_data || jsonb_build_object('owner_id',actor);
      -- Server owns modification time. Original recording time is preserved on insert.
      if record_data ? 'updated_at' then record_data:=record_data || jsonb_build_object('updated_at',clock_timestamp()); end if;
      select string_agg(format('%I',k),',' order by k), string_agg(format('r.%I',k),',' order by k)
        into columns_sql,select_sql from jsonb_object_keys(record_data) k;
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r',table_name,columns_sql,select_sql,table_name) using record_data;
    else
      select string_agg(format('%I=r.%I',k,k),',' order by k) into update_sql from jsonb_object_keys(record_data) k
        where not k=any(keys) and k not in ('created_at','updated_at');
      if update_sql is null then raise exception 'No editable fields' using errcode='22023'; end if;
      -- The update has different parameter positions than the lookup/delete statement.
      select string_agg(format('t.%I=($3->>%L)::uuid',k,k),' and ') into filter_sql from unnest(keys) k;
      execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) r where t.owner_id=$2 and %s',table_name,update_sql,table_name,filter_sql) using record_data,actor,row_key;
    end if;
  end loop;
end;
$$;

revoke all on function public.planner_load_workspace() from public, anon;
revoke all on function public.planner_apply_changes(jsonb) from public, anon;
grant execute on function public.planner_load_workspace() to authenticated;
grant execute on function public.planner_apply_changes(jsonb) to authenticated;
comment on function public.planner_apply_changes(jsonb) is 'Atomic owner-scoped planner mutations; invoker RLS, revision checks and existing domain triggers apply.';
notify pgrst, 'reload schema';
commit;
