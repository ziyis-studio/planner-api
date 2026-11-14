create table public.tag_catalog (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(name) between 1 and 40 and name=lower(btrim(name))),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(owner_id,name)
);
alter table public.tag_catalog enable row level security;
create policy own_tags on public.tag_catalog to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
grant select,insert,update,delete on public.tag_catalog to authenticated;
revoke all on public.tag_catalog from anon;
create trigger preserve_identity_and_touch before update on public.tag_catalog for each row execute function planner_private.preserve_identity_and_touch();
create function public.planner_load_workspace_with_tag_catalog() returns jsonb language sql stable security invoker set search_path='' as $$
 select public.planner_load_workspace_with_tags() || jsonb_build_object('tag_catalog',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.tag_catalog t where owner_id=(select auth.uid())),'[]'::jsonb));
$$;
revoke all on function public.planner_load_workspace_with_tag_catalog() from public,anon;
grant execute on function public.planner_load_workspace_with_tag_catalog() to authenticated;
do $do$ declare definition text; begin
 definition:=pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
 definition:=replace(definition,'case table_name','case table_name');
 definition:=replace(definition, 'when ''notes'' then keys:=', 'when ''tag_catalog'' then keys:=array[''id'']; allowed:=array[''id'',''name'',''created_at'',''updated_at'']; when ''notes'' then keys:=');
 execute definition;
end $do$;
