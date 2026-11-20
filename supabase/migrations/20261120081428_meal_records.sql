begin;
set local lock_timeout='5s';
create function planner_private.valid_meal_photos(photos jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare photo jsonb;
begin
 if jsonb_typeof(photos) is distinct from 'array' then return false; end if;
 if jsonb_array_length(photos)>6 then return false; end if;
 for photo in select value from jsonb_array_elements(photos) loop
  if jsonb_typeof(photo) is distinct from 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(photo))<>2 or
     jsonb_typeof(photo->'ref') is distinct from 'string' or jsonb_typeof(photo->'alt') is distinct from 'string' then return false; end if;
  if length(photo->>'alt')>160 or photo->>'ref' !~ '^planner-image://[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp|gif)$' then return false; end if;
 end loop;
 return (select count(*)=count(distinct value->>'ref') from jsonb_array_elements(photos));
end $$;
revoke all on function planner_private.valid_meal_photos(jsonb) from public,anon;
grant execute on function planner_private.valid_meal_photos(jsonb) to authenticated,service_role;
create table public.meals (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 title text not null default '' check(length(title)<=300),
 description text not null default '' check(length(description)<=10000),
 kind text not null check(kind in ('breakfast','lunch','dinner','snack','other')),
 ate_at timestamptz not null,
 timezone text not null,
 photos jsonb not null default '[]'::jsonb check(planner_private.valid_meal_photos(photos)),
 calories numeric(12,2) check(calories>=0 and calories<=100000),
 protein numeric(12,2) check(protein>=0 and protein<=100000),
 carbs numeric(12,2) check(carbs>=0 and carbs<=100000),
 fat numeric(12,2) check(fat>=0 and fat<=100000),
 fiber numeric(12,2) check(fiber>=0 and fiber<=100000),
 nutrition_source text not null default 'manual' check(nutrition_source in ('manual','external')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint meal_has_content check(length(btrim(title))>0 or length(btrim(description))>0 or jsonb_array_length(photos)>0)
);
comment on table public.meals is 'Meal log. Nutrition amounts describe the whole meal: calories in kcal; protein, carbs, fat and fiber in grams. NULL means not recorded. Photo references point to private planner-images objects at owner_id/ref filename. External analysis may update nutrition columns and nutrition_source=external.';
create index meals_owner_ate_idx on public.meals(owner_id,ate_at desc,id);
alter table public.meals enable row level security;
revoke all on public.meals from public,anon,authenticated;
grant select,insert,update,delete on public.meals to authenticated,service_role;
create policy own_select on public.meals for select to authenticated using(owner_id=(select auth.uid()));
create policy own_insert on public.meals for insert to authenticated with check(owner_id=(select auth.uid()));
create policy own_update on public.meals for update to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy own_delete on public.meals for delete to authenticated using(owner_id=(select auth.uid()));
create trigger preserve_identity_and_touch before update on public.meals for each row execute function planner_private.preserve_identity_and_touch();
create function planner_private.validate_meal() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone) then raise exception 'Choose a valid time zone' using errcode='22023';end if;
 if new.ate_at>clock_timestamp()+interval '1 minute' then raise exception 'Meals must be in the past or present' using errcode='22023';end if;
 return new;
end $$;
revoke all on function planner_private.validate_meal() from public,anon;
grant execute on function planner_private.validate_meal() to authenticated,service_role;
create trigger validate_meal before insert or update on public.meals for each row execute function planner_private.validate_meal();
do $write_api$
declare definition text;anchor text;
begin
 definition:=pg_get_functiondef('public.planner_apply_changes(jsonb)'::regprocedure);
 anchor:=$anchor$when 'sleep_records' then$anchor$;
 if position(anchor in definition)=0 then raise exception 'Unexpected mutation API';end if;
 execute replace(definition,anchor,$case$when 'meals' then keys:=array['id']; allowed:=array['id','title','description','kind','ate_at','timezone','photos','calories','protein','carbs','fat','fiber','nutrition_source','created_at','updated_at'];
      when 'sleep_records' then$case$);
end $write_api$;
-- New RPCs retain the previous wire format for older independently deployed clients.
create function public.planner_load_workspace_with_meals() returns jsonb language sql stable security invoker set search_path='' as $$
 select public.planner_load_workspace_with_ordering() || jsonb_build_object('meals',coalesce((select jsonb_agg(to_jsonb(t) order by ate_at desc,id) from public.meals t where owner_id=(select auth.uid())),'[]'::jsonb));
$$;
revoke all on function public.planner_load_workspace_with_meals() from public,anon;
grant execute on function public.planner_load_workspace_with_meals() to authenticated,service_role;
do $backup$
declare definition text;
begin
 definition:=pg_get_functiondef('public.planner_export_backup_with_ordering()'::regprocedure);
 execute replace(replace(definition,'public.planner_export_backup_with_ordering()', 'public.planner_export_backup_with_meals()'),'public.planner_load_workspace_with_ordering()', 'public.planner_load_workspace_with_meals()');
end $backup$;
revoke all on function public.planner_export_backup_with_meals() from public,anon;
grant execute on function public.planner_export_backup_with_meals() to authenticated,service_role;
notify pgrst,'reload schema';
commit;
