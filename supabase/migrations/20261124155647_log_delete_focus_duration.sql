begin;
set local lock_timeout='5s';
alter table public.pomodoro_sessions drop constraint pomodoro_duration_by_mode;
alter table public.pomodoro_sessions add constraint pomodoro_duration_by_mode check(
 (mode='focus' and duration_seconds between 60 and 10800 and duration_seconds % 60=0) or
 (mode='short' and duration_seconds=300) or (mode='long' and duration_seconds=900)
);
grant delete on public.entity_logs to authenticated;
create policy entity_logs_delete on public.entity_logs for delete to authenticated using(owner_id=(select auth.uid()));
create function public.planner_delete_log(entry_id uuid,entity_kind text,entity_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare actor uuid:=auth.uid();
begin
 if actor is null then raise exception 'Authentication required' using errcode='42501';end if;
 if entity_kind not in ('task','project') then raise exception 'Invalid log target' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,0));
 delete from public.entity_logs where owner_id=actor and id=entry_id and target_kind=entity_kind and target_id=entity_id;
 if not found then raise exception 'Log entry unavailable' using errcode='PT404';end if;
end;$$;
revoke all on function public.planner_delete_log(uuid,text,uuid) from public,anon;
grant execute on function public.planner_delete_log(uuid,text,uuid) to authenticated,service_role;
comment on table public.entity_logs is 'Private manual logs. Bodies and creation timestamps are immutable; authenticated owners may delete their own entries.';
comment on function public.planner_delete_log(uuid,text,uuid) is 'Delete one owner-scoped manual log entry; entry and source target identity must both match.';
comment on constraint pomodoro_duration_by_mode on public.pomodoro_sessions is 'Focus: whole minutes from 1 to 180. Break modes retain 5/15 minute durations. Actual duration is immutable on completed sessions.';
notify pgrst,'reload schema';
commit;
