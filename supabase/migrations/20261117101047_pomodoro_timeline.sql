-- Keep the completion and its ordinary Schedule time block in one transaction.
alter table public.pomodoro_sessions
  add column timezone text not null default 'Asia/Kuala_Lumpur',
  add column time_block_id uuid default gen_random_uuid();

create function public.pomodoro_record_time_block()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Invalid Pomodoro time zone' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.owner_id::text, 0));
  insert into public.time_blocks (id, owner_id, title, description, starts_at, ends_at, timezone, created_at)
  values (new.time_block_id, new.owner_id,
    'Pomodoro · ' || case new.mode when 'focus' then 'Focus' when 'short' then 'Short break' else 'Long break' end,
    pg_catalog.format(E'%s time: %s min\nElapsed: %s min\nPaused: %s min\nAutomatically recorded from Pomodoro.',
      case new.mode when 'focus' then 'Focus' else 'Break' end, new.duration_seconds / 60,
      pg_catalog.round(extract(epoch from (new.completed_at - new.started_at)) / 60, 1),
      pg_catalog.round(greatest(0, extract(epoch from (new.completed_at - new.started_at)) - new.duration_seconds) / 60, 1)),
    new.started_at, new.completed_at, new.timezone, new.created_at);
  return new;
end;
$$;
revoke all on function public.pomodoro_record_time_block() from public, anon;
grant execute on function public.pomodoro_record_time_block() to authenticated, service_role;
create trigger pomodoro_to_schedule after insert on public.pomodoro_sessions
  for each row execute function public.pomodoro_record_time_block();

-- Existing completion history becomes visible once; no user time blocks change.
insert into public.time_blocks (id, owner_id, title, description, starts_at, ends_at, timezone, created_at)
select time_block_id, owner_id,
  'Pomodoro · ' || case mode when 'focus' then 'Focus' when 'short' then 'Short break' else 'Long break' end,
  pg_catalog.format(E'%s time: %s min\nElapsed: %s min\nPaused: %s min\nAutomatically recorded from Pomodoro.',
    case mode when 'focus' then 'Focus' else 'Break' end, duration_seconds / 60,
    pg_catalog.round(extract(epoch from (completed_at - started_at)) / 60, 1),
    pg_catalog.round(greatest(0, extract(epoch from (completed_at - started_at)) - duration_seconds) / 60, 1)),
  started_at, completed_at, timezone, created_at
from public.pomodoro_sessions;

alter table public.pomodoro_sessions add constraint pomodoro_schedule_owner_fk
  foreign key (owner_id, time_block_id) references public.time_blocks(owner_id, id)
  on delete set null (time_block_id) deferrable initially deferred;
create unique index pomodoro_sessions_time_block on public.pomodoro_sessions(time_block_id);
notify pgrst, 'reload schema';
