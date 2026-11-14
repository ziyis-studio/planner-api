-- Additive page databases. Existing notes and API versions are preserved.
create table public.note_databases (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 title text not null check(length(btrim(title))>0), description text not null default '',
 note_id uuid references public.notes(id) on delete set null,
 fields jsonb not null default '[]'::jsonb check(jsonb_typeof(fields)='array' and jsonb_array_length(fields)<=30),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(id,owner_id)
);
create index note_databases_owner_idx on public.note_databases(owner_id);
create index note_databases_note_idx on public.note_databases(note_id);
create table public.database_records (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 database_id uuid not null,
 title text not null check(length(btrim(title))>0),content text not null default '',
 "values" jsonb not null default '{}'::jsonb check(jsonb_typeof("values")='object'),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(database_id,owner_id) references public.note_databases(id,owner_id) on delete cascade
);
create index database_records_owner_database_idx on public.database_records(owner_id,database_id);
create index database_records_database_idx on public.database_records(database_id);
alter table public.note_databases enable row level security;
alter table public.database_records enable row level security;
create policy own_note_databases on public.note_databases to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy own_database_records on public.database_records to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
revoke all on public.note_databases,public.database_records from anon;
grant select,insert,update,delete on public.note_databases,public.database_records to authenticated;
create trigger preserve_identity_and_touch before update on public.note_databases for each row execute function planner_private.preserve_identity_and_touch();
create trigger preserve_identity_and_touch before update on public.database_records for each row execute function planner_private.preserve_identity_and_touch();

create function planner_private.validate_note_database() returns trigger language plpgsql security invoker set search_path='' as $$
declare f jsonb; names text[]:='{}'; ids text[]:='{}';
begin
 if new.note_id is not null and not exists(select 1 from public.notes n where n.id=new.note_id and n.owner_id=new.owner_id) then raise exception 'Invalid parent note'; end if;
 for f in select value from jsonb_array_elements(new.fields) loop
  if jsonb_typeof(f)<>'object' or not (f ?& array['id','name','type','options']) or (f-array['id','name','type','options'])<>'{}'::jsonb or
     jsonb_typeof(f->'id')<>'string' or jsonb_typeof(f->'name')<>'string' or f->>'type' is null or coalesce(length(btrim(f->>'name')),0) not between 1 and 80 or f->>'type' not in ('text','number','date','status','checkbox','tags') or
     jsonb_typeof(f->'options')<>'array' or jsonb_array_length(f->'options')>50 then raise exception 'Invalid database property'; end if;
  perform (f->>'id')::uuid;
  if f->>'id'=any(ids) or lower(f->>'name')=any(names) then raise exception 'Duplicate database property'; end if;
  if exists(select 1 from jsonb_array_elements(f->'options') o where jsonb_typeof(o)<>'string' or length(btrim(o#>>'{}')) not between 1 and 80) then raise exception 'Invalid property options'; end if;
  if (select count(*)<>count(distinct value) from jsonb_array_elements(f->'options')) then raise exception 'Duplicate property options'; end if;
  if tg_op='UPDATE' and exists(select 1 from jsonb_array_elements(old.fields) o where o->>'id'=f->>'id' and o->>'type'<>f->>'type') then raise exception 'Property types cannot be changed'; end if;
  ids:=array_append(ids,f->>'id');names:=array_append(names,lower(f->>'name'));
 end loop;
 return new;
end $$;
create trigger validate_note_database before insert or update on public.note_databases for each row execute function planner_private.validate_note_database();

-- Validate against final transaction state so property removal and row cleanup are atomic.
create function planner_private.validate_database_values() returns trigger language plpgsql security invoker set search_path='' as $$
declare dbid uuid; recordid uuid; fields jsonb; r record; pair record; f jsonb; kind text;
begin
 if tg_table_name='note_databases' then dbid:=new.id; else dbid:=new.database_id; recordid:=new.id; end if;
 select d.fields into fields from public.note_databases d where d.id=dbid;
 if fields is null then return null; end if;
 for r in select "values" from public.database_records where database_id=dbid and (recordid is null or id=recordid) loop
  for pair in select key,value from jsonb_each(r.values) loop
   select x into f from jsonb_array_elements(fields) x where x->>'id'=pair.key;
   if f is null then raise exception 'Unknown database property'; end if;
   if pair.value='""'::jsonb then continue; end if;
   kind:=f->>'type';
   if (kind='number' and jsonb_typeof(pair.value)<>'number') or (kind='checkbox' and jsonb_typeof(pair.value)<>'boolean') or
      (kind in ('text','date','status') and jsonb_typeof(pair.value)<>'string') or (kind='tags' and jsonb_typeof(pair.value)<>'array') then raise exception 'Invalid property value type'; end if;
   if kind='status' and not (f->'options' @> jsonb_build_array(pair.value)) then raise exception 'Unknown status'; end if;
   if kind='date' then
    if (pair.value#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid property date'; end if;
    perform (pair.value#>>'{}')::date;
   end if;
   if kind='tags' and (jsonb_array_length(pair.value)>50 or exists(select 1 from jsonb_array_elements(pair.value) v where jsonb_typeof(v)<>'string' or length(v#>>'{}')>80)) then raise exception 'Invalid property tags'; end if;
  end loop;
 end loop;
 return null;
end $$;
create constraint trigger validate_database_values after insert or update on public.database_records deferrable initially deferred for each row execute function planner_private.validate_database_values();
create constraint trigger validate_database_schema after update on public.note_databases deferrable initially deferred for each row execute function planner_private.validate_database_values();
revoke all on function planner_private.validate_note_database(),planner_private.validate_database_values() from public,anon;

create function public.planner_load_workspace_with_databases() returns jsonb language sql stable security invoker set search_path='' as $$
 select public.planner_load_workspace_with_tag_catalog() || jsonb_build_object(
 'note_databases',coalesce((select jsonb_agg(to_jsonb(d) order by id) from public.note_databases d where owner_id=(select auth.uid())),'[]'::jsonb),
 'database_records',coalesce((select jsonb_agg(to_jsonb(r) order by id) from public.database_records r where owner_id=(select auth.uid())),'[]'::jsonb));
$$;
revoke all on function public.planner_load_workspace_with_databases() from public,anon;
grant execute on function public.planner_load_workspace_with_databases() to authenticated;
do $do$ declare definition text; anchor text:='when ''notes'' then keys:='; begin
 definition:=pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
 if position(anchor in definition)=0 then raise exception 'Workspace change API version does not match'; end if;
 definition:=replace(definition,anchor, 'when ''note_databases'' then keys:=array[''id'']; allowed:=array[''id'',''title'',''description'',''note_id'',''fields'',''created_at'',''updated_at'']; when ''database_records'' then keys:=array[''id'']; allowed:=array[''id'',''database_id'',''title'',''content'',''values'',''created_at'',''updated_at'']; '||anchor);
 execute definition;
end $do$;

-- Check the schema revision under the same owner lock used for writes.
create function public.planner_apply_database_record_changes(changes jsonb, database_id uuid, database_revision timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 if not exists(select 1 from public.note_databases d where d.id=database_id and d.owner_id=auth.uid() and d.updated_at=database_revision) then
  raise exception 'Database schema changed' using errcode='PT409';
 end if;
 perform public.planner_apply_changes(changes);
end $$;
revoke all on function public.planner_apply_database_record_changes(jsonb,uuid,timestamptz) from public,anon;
grant execute on function public.planner_apply_database_record_changes(jsonb,uuid,timestamptz) to authenticated;
