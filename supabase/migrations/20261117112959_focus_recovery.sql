-- Task-aware focus history and recoverable workspace mutations, scoped by RLS.
alter table public.pomodoro_sessions
  add column task_id uuid,
  add column task_snapshot_id uuid,
  add column task_title text not null default '' check (length(task_title) <= 300),
  add constraint pomodoro_task_owner_fk foreign key (owner_id, task_id)
    references public.tasks(owner_id,id) on delete set null (task_id);
create index pomodoro_sessions_task on public.pomodoro_sessions(owner_id,task_id) where task_id is not null;
alter table public.time_blocks
  add column recorded_type text check (recorded_type in ('focus','short','long')),
  add column source_session_id uuid,
  add constraint time_block_session_owner_fk foreign key (owner_id,source_session_id)
    references public.pomodoro_sessions(owner_id,id) deferrable initially deferred;
create index time_blocks_source_session on public.time_blocks(owner_id,source_session_id) where source_session_id is not null;
update public.time_blocks b set recorded_type=s.mode, source_session_id=s.id
from public.pomodoro_sessions s where b.owner_id=s.owner_id and b.id=s.time_block_id;

create function public.pomodoro_validate_task() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  new.task_snapshot_id:=coalesce(new.task_snapshot_id,new.task_id);
  if new.mode <> 'focus' then new.task_id:=null; new.task_snapshot_id:=null; new.task_title:=''; end if;
  if new.task_id is not null then
    if exists(select 1 from public.tasks where owner_id=new.owner_id and id=new.task_id) then
      if new.task_title='' then select title into new.task_title from public.tasks where owner_id=new.owner_id and id=new.task_id; end if;
    else new.task_id:=null; end if;
  end if;
  return new;
end; $$;
create trigger pomodoro_task_before_insert before insert on public.pomodoro_sessions for each row execute function public.pomodoro_validate_task();

create or replace function public.pomodoro_record_time_block()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare existing public.time_blocks;
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then raise exception 'Invalid Pomodoro time zone' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.owner_id::text, 0));
  -- A deliberately deleted block stays deleted when history is restored.
  if new.time_block_id is null then return new; end if;
  select * into existing from public.time_blocks where owner_id=new.owner_id and id=new.time_block_id for update;
  if found then
    if existing.source_session_id is not null and existing.source_session_id<>new.id then raise exception 'Recording identity conflict' using errcode='PT409'; end if;
    if existing.source_session_id is distinct from new.id and (existing.starts_at<>new.started_at or existing.ends_at<>new.completed_at) then raise exception 'Recording time conflict' using errcode='PT409'; end if;
    update public.time_blocks set recorded_type=new.mode,source_session_id=new.id where owner_id=new.owner_id and id=new.time_block_id;
  else
    insert into public.time_blocks (id,owner_id,title,description,starts_at,ends_at,timezone,created_at,recorded_type,source_session_id)
    values (new.time_block_id,new.owner_id,
      case when new.mode='focus' and new.task_title<>'' then new.task_title else 'Pomodoro · '||case new.mode when 'focus' then 'Focus' when 'short' then 'Short break' else 'Long break' end end,
      pg_catalog.format(E'%s time: %s min\nElapsed: %s min\nPaused: %s min\nAutomatically recorded from Pomodoro.',case new.mode when 'focus' then 'Focus' else 'Break' end,new.duration_seconds/60,pg_catalog.round(extract(epoch from (new.completed_at-new.started_at))/60,1),pg_catalog.round(greatest(0,extract(epoch from (new.completed_at-new.started_at))-new.duration_seconds)/60,1)),
      new.started_at,new.completed_at,new.timezone,new.created_at,new.mode,new.id);
  end if;
  if new.task_id is not null then
    insert into public.time_block_tasks(owner_id,time_block_id,task_id) values(new.owner_id,new.time_block_id,new.task_id) on conflict do nothing;
  end if;
  return new;
end; $$;
-- Only nullable references can change; completion times and duration remain immutable.
grant update(time_block_id,task_id) on public.pomodoro_sessions to authenticated;
create policy pomodoro_relink_own on public.pomodoro_sessions for update to authenticated
using ((select auth.uid())=owner_id) with check (
 (select auth.uid())=owner_id and
 (task_id is null or task_id=task_snapshot_id) and
 (time_block_id is null or exists(select 1 from public.time_blocks b where b.owner_id=(select auth.uid()) and b.id=time_block_id and b.source_session_id=pomodoro_sessions.id))
);
create table public.planner_recovery (
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 id uuid not null default gen_random_uuid(),kind text not null check(length(kind)<=80),title text not null check(length(title)<=500),
 deleted_at timestamptz not null default now(),restored_at timestamptz,
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=2500000),primary key(owner_id,id)
);
create index planner_recovery_deleted on public.planner_recovery(owner_id,deleted_at desc) where restored_at is null;
alter table public.planner_recovery enable row level security;
revoke all on public.planner_recovery from anon,authenticated;
grant select,insert,update,delete on public.planner_recovery to authenticated;
grant all on public.planner_recovery to service_role;
create policy recovery_owner on public.planner_recovery for all to authenticated using((select auth.uid())=owner_id) with check((select auth.uid())=owner_id);

create function public.planner_apply_recoverable_changes(changes jsonb,recovery jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform public.planner_apply_changes(changes);
 insert into public.planner_recovery(owner_id,id,kind,title,payload) values(auth.uid(),(recovery->>'id')::uuid,recovery->>'kind',recovery->>'title',recovery->'payload');
end; $$;
create function public.planner_relink_recordings(recorded_blocks jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare b jsonb; sid uuid; bid uuid; m text;
begin
 for b in select value from jsonb_array_elements(recorded_blocks) loop
  sid:=(b->>'sourceSessionId')::uuid; bid:=(b->>'id')::uuid;
  select mode into m from public.pomodoro_sessions where owner_id=auth.uid() and id=sid;
  if m is not null then
   if exists(select 1 from public.pomodoro_sessions where owner_id=auth.uid() and id=sid and time_block_id is not null and time_block_id<>bid) then raise exception 'Recording already linked' using errcode='PT409'; end if;
   update public.time_blocks set recorded_type=m,source_session_id=sid where owner_id=auth.uid() and id=bid and (source_session_id is null or source_session_id=sid) and (recorded_type is distinct from m or source_session_id is distinct from sid);
   update public.pomodoro_sessions set time_block_id=bid where owner_id=auth.uid() and id=sid and time_block_id is null and exists(select 1 from public.time_blocks where owner_id=auth.uid() and id=bid and source_session_id=sid);
  end if;
 end loop;
 update public.pomodoro_sessions s set task_id=s.task_snapshot_id where s.owner_id=auth.uid() and s.task_id is null and exists(select 1 from public.tasks t where t.owner_id=auth.uid() and t.id=s.task_snapshot_id);
end; $$;
create function public.planner_restore_recovery(entry_id uuid,changes jsonb,recorded_blocks jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare e public.planner_recovery;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,0));
 select * into e from public.planner_recovery where owner_id=auth.uid() and id=entry_id for update;
 if not found then raise exception 'Recovery entry missing' using errcode='PT409'; end if;
 if e.restored_at is not null then return; end if;
 perform public.planner_apply_changes(changes);
 perform public.planner_relink_recordings(recorded_blocks);
 update public.planner_recovery set restored_at=clock_timestamp() where owner_id=auth.uid() and id=entry_id;
end; $$;
create function public.planner_import_backup(changes jsonb,sessions jsonb,trash jsonb,recorded_blocks jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare s jsonb; t jsonb;
begin
 perform public.planner_apply_changes(changes);
 -- Provenance survives an exported recording whose title or time was edited.
 update public.time_blocks b set recorded_type=s->>'mode',source_session_id=(s->>'id')::uuid
 from jsonb_array_elements(sessions) s, jsonb_array_elements(recorded_blocks) r
 where b.owner_id=auth.uid() and b.id=(s->>'time_block_id')::uuid and b.id=(r->>'id')::uuid
 and (r->>'sourceSessionId')::uuid=(s->>'id')::uuid and b.source_session_id is null
 and not exists(select 1 from public.pomodoro_sessions p where p.owner_id=auth.uid() and p.id=(s->>'id')::uuid);
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
revoke all on function public.pomodoro_validate_task(),public.planner_apply_recoverable_changes(jsonb,jsonb),public.planner_relink_recordings(jsonb),public.planner_restore_recovery(uuid,jsonb,jsonb),public.planner_import_backup(jsonb,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.pomodoro_validate_task(),public.planner_apply_recoverable_changes(jsonb,jsonb),public.planner_relink_recordings(jsonb),public.planner_restore_recovery(uuid,jsonb,jsonb),public.planner_import_backup(jsonb,jsonb,jsonb,jsonb) to authenticated,service_role;
notify pgrst,'reload schema';
