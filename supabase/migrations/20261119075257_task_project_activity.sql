-- Append-only private comments. Original target identity survives Trash deletion
-- so restoring a task/project restores access to its history without copying it.
create table public.entity_logs (
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 id uuid not null default gen_random_uuid(),
 target_kind text not null check(target_kind in ('task','project')),
 target_id uuid not null,
 task_id uuid,
 project_id uuid,
 body text not null check(length(btrim(body)) between 1 and 10000),
 created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
 primary key(owner_id,id),
 constraint entity_log_task_owner_fk foreign key(owner_id,task_id) references public.tasks(owner_id,id) on delete set null(task_id),
 constraint entity_log_project_owner_fk foreign key(owner_id,project_id) references public.projects(owner_id,id) on delete set null(project_id),
 constraint entity_log_pointer check((target_kind='task' and project_id is null and (task_id is null or task_id=target_id)) or (target_kind='project' and task_id is null and (project_id is null or project_id=target_id)))
);
create index entity_logs_target_time on public.entity_logs(owner_id,target_kind,target_id,created_at desc,id desc);
create index entity_logs_task_fk on public.entity_logs(owner_id,task_id) where task_id is not null;
create index entity_logs_project_fk on public.entity_logs(owner_id,project_id) where project_id is not null;
alter table public.entity_logs enable row level security;
revoke all on public.entity_logs from anon,authenticated;
grant select,insert on public.entity_logs to authenticated;
grant all on public.entity_logs to service_role;
create policy entity_logs_read on public.entity_logs for select to authenticated using((select auth.uid())=owner_id);
create policy entity_logs_insert on public.entity_logs for insert to authenticated with check((select auth.uid())=owner_id);
create function public.entity_log_bind_target() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 new.task_id:=null;new.project_id:=null;
 if new.target_kind='task' then select id into new.task_id from public.tasks where owner_id=new.owner_id and id=new.target_id;
 else select id into new.project_id from public.projects where owner_id=new.owner_id and id=new.target_id;end if;
 return new;
end;$$;
create trigger entity_logs_bind before insert on public.entity_logs for each row execute function public.entity_log_bind_target();
create function public.planner_append_log(entry_id uuid,entity_kind text,entity_id uuid,entry_body text) returns public.entity_logs
language plpgsql security invoker set search_path='' as $$
declare actor uuid:=auth.uid();result public.entity_logs;
begin
 if actor is null then raise exception 'Authentication required' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,0));
 if not ((entity_kind='task' and exists(select 1 from public.tasks where owner_id=actor and id=entity_id)) or (entity_kind='project' and exists(select 1 from public.projects where owner_id=actor and id=entity_id))) then raise exception 'Item unavailable' using errcode='PT404';end if;
 insert into public.entity_logs(owner_id,id,target_kind,target_id,body) values(actor,entry_id,entity_kind,entity_id,btrim(entry_body)) on conflict(owner_id,id) do nothing;
 select * into result from public.entity_logs where owner_id=actor and id=entry_id;
 if result.target_kind<>entity_kind or result.target_id<>entity_id or result.body<>btrim(entry_body) then raise exception 'Entry identity conflict' using errcode='PT409';end if;
 return result;
end;$$;
create function public.planner_activity_log(entity_kind text,entity_id uuid,before_at timestamptz default null,before_id uuid default null) returns setof public.entity_logs
language plpgsql security invoker set search_path='' as $$
declare actor uuid:=auth.uid();
begin
 if actor is null then raise exception 'Authentication required' using errcode='42501';end if;
 if not ((entity_kind='task' and exists(select 1 from public.tasks where owner_id=actor and id=entity_id)) or (entity_kind='project' and exists(select 1 from public.projects where owner_id=actor and id=entity_id))) then raise exception 'Item unavailable' using errcode='PT404';end if;
 if (before_at is null)<>(before_id is null) then raise exception 'Incomplete cursor' using errcode='22023';end if;
 return query select l.* from public.entity_logs l where l.owner_id=actor and (
  (l.target_kind=entity_kind and l.target_id=entity_id) or
  (entity_kind='project' and l.target_kind='task' and exists(select 1 from public.tasks t where t.owner_id=actor and t.id=l.target_id and t.project_id=entity_id))
 ) and (before_at is null or (l.created_at,l.id)<(before_at,before_id)) order by l.created_at desc,l.id desc limit 51;
end;$$;
-- Add logs to the existing owner-serialized backup transaction.
create or replace function public.planner_export_backup() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare actor uuid:=auth.uid();result jsonb;
begin
 if actor is null then raise exception 'Authentication required' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,0));
 select jsonb_build_object('app','ONE','version',2,'id',gen_random_uuid(),'ownerId',actor,'exportedAt',clock_timestamp(),
  'workspace',public.planner_load_workspace_with_databases(),
  'sessions',coalesce((select jsonb_agg(to_jsonb(s)-'owner_id'-'created_at' order by s.id) from public.pomodoro_sessions s where owner_id=actor),'[]'::jsonb),
  'trash',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'title',r.title,'deletedAt',r.deleted_at,'restoredAt',r.restored_at,'patch',r.payload) order by r.id) from public.planner_recovery r where owner_id=actor),'[]'::jsonb),
  'activity',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'target_kind',l.target_kind,'target_id',l.target_id,'body',l.body,'created_at',l.created_at) order by l.id) from public.entity_logs l where owner_id=actor),'[]'::jsonb)) into result;
 return result;
end;$$;
create function public.planner_import_backup_with_activity(changes jsonb,sessions jsonb,trash jsonb,recorded_blocks jsonb,activity jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare e jsonb;
begin
 perform public.planner_import_backup(changes,sessions,trash,recorded_blocks);
 for e in select value from jsonb_array_elements(activity) loop
  insert into public.entity_logs(owner_id,id,target_kind,target_id,body,created_at)
  values(auth.uid(),(e->>'id')::uuid,e->>'target_kind',(e->>'target_id')::uuid,e->>'body',(e->>'created_at')::timestamptz) on conflict(owner_id,id) do nothing;
 end loop;
end;$$;
revoke all on function public.entity_log_bind_target(),public.planner_append_log(uuid,text,uuid,text),public.planner_activity_log(text,uuid,timestamptz,uuid),public.planner_import_backup_with_activity(jsonb,jsonb,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.entity_log_bind_target(),public.planner_append_log(uuid,text,uuid,text),public.planner_activity_log(text,uuid,timestamptz,uuid),public.planner_import_backup_with_activity(jsonb,jsonb,jsonb,jsonb,jsonb) to authenticated,service_role;
notify pgrst,'reload schema';
