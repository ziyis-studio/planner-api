-- An account alias, deliberately separate from the twelve workspace tables.
create table public.account_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  constraint account_profiles_username_format check (
    username = lower(username) and username ~ '^[a-z0-9][a-z0-9_.-]{2,31}$'
  )
);
alter table public.account_profiles enable row level security;
revoke all on public.account_profiles from public, anon, authenticated;
grant select on public.account_profiles to authenticated;
grant insert(user_id, username), update(user_id, username) on public.account_profiles to authenticated;
grant select on public.account_profiles to service_role;
create policy account_profiles_read_self on public.account_profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy account_profiles_insert_self on public.account_profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy account_profiles_update_self on public.account_profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Only the login function's server identity can use the limiter. No raw IPs, emails,
-- passwords or tokens are stored. Old fixed-window buckets are pruned on requests.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;
create table private.username_login_limits (
  bucket text primary key,
  window_start timestamptz not null,
  attempts integer not null check (attempts > 0)
);
create index username_login_limits_window_idx on private.username_login_limits(window_start);
alter table private.username_login_limits enable row level security;
revoke all on private.username_login_limits from public, anon, authenticated;
grant select, insert, update, delete on private.username_login_limits to service_role;

create function public.planner_consume_username_login_limit(p_client_hash text, p_username_hash text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_window timestamptz := date_trunc('minute', v_now);
  v_prefix text := extract(epoch from v_window)::bigint::text || ':';
  v_bucket text;
  v_limit integer;
  v_count integer;
  v_index integer;
begin
  if p_client_hash !~ '^[a-f0-9]{64}$' or p_username_hash !~ '^[a-f0-9]{64}$'
     or p_client_hash is null or p_username_hash is null then
    raise exception 'Invalid limiter key' using errcode = '22023';
  end if;
  delete from private.username_login_limits where bucket in (
    select bucket from private.username_login_limits
    where window_start < v_now - interval '1 hour' order by window_start limit 100
  ) and window_start < v_now - interval '1 hour';
  -- A global ceiling also bounds attempts when a forwarded network header is absent/spoofed.
  for v_index in 1..3 loop
    v_bucket := v_prefix || case v_index when 1 then 'global' when 2 then 'client:' || p_client_hash else 'username:' || p_username_hash end;
    v_limit := case v_index when 1 then 120 when 2 then 20 else 8 end;
    insert into private.username_login_limits(bucket, window_start, attempts)
    values(v_bucket, v_window, 1)
    on conflict (bucket) do update set attempts = least(private.username_login_limits.attempts + 1, v_limit + 1)
    returning attempts into v_count;
    if v_count > v_limit then return false; end if;
  end loop;
  return true;
end;
$$;
revoke all on function public.planner_consume_username_login_limit(text,text) from public, anon, authenticated;
grant execute on function public.planner_consume_username_login_limit(text,text) to service_role;
