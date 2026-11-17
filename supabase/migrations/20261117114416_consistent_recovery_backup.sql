-- A single transaction sees a consistent workspace, history and recovery set.
create function public.planner_export_backup() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare actor uuid:=auth.uid();result jsonb;
begin
 if actor is null then raise exception 'Authentication required' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,0));
 select jsonb_build_object('app','ONE','version',2,'id',gen_random_uuid(),'ownerId',actor,'exportedAt',clock_timestamp(),
  'workspace',public.planner_load_workspace_with_databases(),
  'sessions',coalesce((select jsonb_agg(to_jsonb(s)-'owner_id'-'created_at' order by s.id) from public.pomodoro_sessions s where owner_id=actor),'[]'::jsonb),
  'trash',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'title',r.title,'deletedAt',r.deleted_at,'restoredAt',r.restored_at,'patch',r.payload) order by r.id) from public.planner_recovery r where owner_id=actor),'[]'::jsonb)) into result;
 return result;
end; $$;
revoke all on function public.planner_export_backup() from public,anon;
grant execute on function public.planner_export_backup() to authenticated,service_role;
notify pgrst,'reload schema';
