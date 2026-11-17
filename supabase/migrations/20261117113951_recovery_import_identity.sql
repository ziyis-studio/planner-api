-- Qualify JSON aliases independently from the PL/pgSQL session variable.
create or replace function public.planner_import_backup(changes jsonb,sessions jsonb,trash jsonb,recorded_blocks jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare s jsonb; t jsonb;
begin
 perform public.planner_apply_changes(changes);
 -- Provenance survives an exported recording whose title or time was edited.
 update public.time_blocks b set recorded_type=incoming.value->>'mode',source_session_id=(incoming.value->>'id')::uuid
 from jsonb_array_elements(sessions) incoming(value), jsonb_array_elements(recorded_blocks) recording(value)
 where b.owner_id=auth.uid() and b.id=(incoming.value->>'time_block_id')::uuid and b.id=(recording.value->>'id')::uuid
 and (recording.value->>'sourceSessionId')::uuid=(incoming.value->>'id')::uuid and b.source_session_id is null
 and not exists(select 1 from public.pomodoro_sessions p where p.owner_id=auth.uid() and p.id=(incoming.value->>'id')::uuid);
 for s in select value from jsonb_array_elements(sessions) loop
  insert into public.pomodoro_sessions(owner_id,id,mode,started_at,completed_at,duration_seconds,timezone,time_block_id,task_id,task_snapshot_id,task_title)
  values(auth.uid(),(s->>'id')::uuid,s->>'mode',(s->>'started_at')::timestamptz,(s->>'completed_at')::timestamptz,(s->>'duration_seconds')::integer,coalesce(s->>'timezone','Asia/Kuala_Lumpur'),(s->>'time_block_id')::uuid,(s->>'task_id')::uuid,(s->>'task_snapshot_id')::uuid,coalesce(s->>'task_title','')) on conflict(owner_id,id) do nothing;
 end loop;
 for t in select value from jsonb_array_elements(trash) loop
  insert into public.planner_recovery(owner_id,id,kind,title,deleted_at,restored_at,payload)
  values(auth.uid(),(t->>'id')::uuid,t->>'kind',t->>'title',(t->>'deletedAt')::timestamptz,(t->>'restoredAt')::timestamptz,t->'patch') on conflict(owner_id,id) do nothing;
 end loop;
 perform public.planner_relink_recordings(recorded_blocks);
end; $$;
notify pgrst,'reload schema';
