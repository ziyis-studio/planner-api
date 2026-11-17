-- Completed sessions are append-only; retries across tabs/devices are idempotent.
create table public.pomodoro_sessions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  mode text not null check (mode in ('focus', 'short', 'long')),
  started_at timestamptz not null,
  completed_at timestamptz not null,
  duration_seconds integer not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  constraint pomodoro_duration_by_mode check (
    duration_seconds = case mode when 'focus' then 1500 when 'short' then 300 when 'long' then 900 end
  ),
  constraint pomodoro_session_elapsed check (
    completed_at >= started_at + duration_seconds * interval '1 second'
  ),
  constraint pomodoro_session_time check (isfinite(started_at) and isfinite(completed_at) and completed_at <= now() + interval '1 minute')
);
create index pomodoro_sessions_owner_completed on public.pomodoro_sessions(owner_id, completed_at desc);
alter table public.pomodoro_sessions enable row level security;
revoke all on public.pomodoro_sessions from anon, authenticated;
grant select, insert on public.pomodoro_sessions to authenticated;
grant all on public.pomodoro_sessions to service_role;
create policy pomodoro_read_own on public.pomodoro_sessions
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy pomodoro_insert_own on public.pomodoro_sessions
  for insert to authenticated with check ((select auth.uid()) = owner_id);
