-- Cover both columns of the owner-scoped timeline FK with the same unique lookup.
create unique index pomodoro_sessions_owner_time_block on public.pomodoro_sessions(owner_id, time_block_id);
drop index public.pomodoro_sessions_time_block;
