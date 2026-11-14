-- Manual sleep records, isolated by the existing personal ownership boundary.
begin;
create extension if not exists btree_gist with schema extensions;
create table public.sleep_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  awake_minutes integer not null default 0,
  timezone text not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sleep_record_duration check (ends_at > starts_at and awake_minutes >= 0 and awake_minutes < extract(epoch from (ends_at-starts_at))/60),
  constraint sleep_records_no_overlap exclude using gist
    (owner_id extensions.gist_uuid_ops with =, tstzrange(starts_at,ends_at,'[)') with &&)
);
create index sleep_records_owner_end_idx on public.sleep_records(owner_id,ends_at desc);
alter table public.sleep_records enable row level security;
revoke all on public.sleep_records from public,anon,authenticated;
grant select,insert,update,delete on public.sleep_records to authenticated;
create policy own_select on public.sleep_records for select to authenticated using(owner_id=(select auth.uid()));
create policy own_insert on public.sleep_records for insert to authenticated with check(owner_id=(select auth.uid()));
create policy own_update on public.sleep_records for update to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy own_delete on public.sleep_records for delete to authenticated using(owner_id=(select auth.uid()));
create trigger preserve_identity_and_touch before update on public.sleep_records for each row execute function planner_private.preserve_identity_and_touch();
create function planner_private.validate_sleep_record()
returns trigger language plpgsql security invoker set search_path='' as $function$
begin
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone) then
    raise exception 'Choose a valid time zone' using errcode='22023';
  end if;
  if new.ends_at > clock_timestamp() + interval '1 minute' then
    raise exception 'Sleep records must finish in the past' using errcode='22023';
  end if;
  return new;
end $function$;
revoke all on function planner_private.validate_sleep_record() from public,anon;
grant execute on function planner_private.validate_sleep_record() to authenticated;
create trigger validate_sleep_record before insert or update on public.sleep_records
for each row execute function planner_private.validate_sleep_record();

-- Extend the current API definition without reverting later icon/order/revision additions.
do $migration$
declare
  definition text;
  anchor text;
  replacement text;
begin
  definition := pg_get_functiondef('public.planner_load_workspace()'::regprocedure);
  anchor := $$'notes', coalesce$$;
  if position(anchor in definition)=0 then
    raise exception 'Unexpected workspace load API; review this migration';
  end if;
  replacement := $$'sleep_records', coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.sleep_records t where owner_id=(select auth.uid())), '[]'::jsonb),
    'notes', coalesce$$;
  execute replace(definition,anchor,replacement);

  definition := pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
  anchor := $$when 'notes' then$$;
  if position(anchor in definition)=0 then
    raise exception 'Unexpected workspace mutation API; review this migration';
  end if;
  replacement := $$when 'sleep_records' then keys:=array['id']; allowed:=array['id','starts_at','ends_at','awake_minutes','timezone','note','created_at','updated_at'];
      when 'notes' then$$;
  execute replace(definition,anchor,replacement);
end $migration$;
notify pgrst, 'reload schema';
commit;
