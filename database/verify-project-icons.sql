-- All fixtures and mutations are rolled back, locally and against the live project.
begin;
insert into auth.users(id,email) values ('95000000-0000-4000-8000-000000000001','icons-owner@example.invalid'),('95000000-0000-4000-8000-000000000002','icons-other@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','95000000-0000-4000-8000-000000000001',true);
select public.planner_apply_changes('[{"table":"projects","action":"insert","row":{"id":"95100000-0000-4000-8000-000000000001","title":"Legacy project"}},{"table":"projects","action":"insert","row":{"id":"95100000-0000-4000-8000-000000000002","title":"Icon project","icon":"home"}}]');
do $$ declare revision text; begin
  if (select icon from public.projects where id='95100000-0000-4000-8000-000000000001') is not null then raise exception 'Legacy default'; end if;
  if not exists(select 1 from jsonb_array_elements(public.planner_load_workspace()->'projects') p where p->>'id'='95100000-0000-4000-8000-000000000002' and p->>'icon'='home') then raise exception 'Icon roundtrip'; end if;
  select updated_at::text into revision from public.projects where id='95100000-0000-4000-8000-000000000002';
  begin
    perform public.planner_apply_changes(jsonb_build_array(jsonb_build_object('table','projects','action','update','expectedUpdatedAt',revision,'row',jsonb_build_object('id','95100000-0000-4000-8000-000000000002','icon','unsafe-url'))));
    raise exception 'Invalid icon accepted';
  exception when check_violation then null; end;
  select updated_at::text into revision from public.projects where id='95100000-0000-4000-8000-000000000002';
  perform public.planner_apply_changes(jsonb_build_array(jsonb_build_object('table','projects','action','update','expectedUpdatedAt',revision,'row',jsonb_build_object('id','95100000-0000-4000-8000-000000000002','completed_at',clock_timestamp()))));
  select updated_at::text into revision from public.projects where id='95100000-0000-4000-8000-000000000002';
  perform public.planner_apply_changes(jsonb_build_array(jsonb_build_object('table','projects','action','update','expectedUpdatedAt',revision,'row',jsonb_build_object('id','95100000-0000-4000-8000-000000000002','icon','code'))));
  if not exists(select 1 from public.projects where id='95100000-0000-4000-8000-000000000002' and icon='code' and completed_at is not null) then raise exception 'Icon changed completion'; end if;
  begin
    perform public.planner_apply_changes('[{"table":"projects","action":"update","expectedUpdatedAt":"2000-01-01T00:00:00Z","row":{"id":"95100000-0000-4000-8000-000000000002","icon":"heart"}}]');
    raise exception 'Stale icon accepted';
  exception when sqlstate 'PT409' then null; end;
  select updated_at::text into revision from public.projects where id='95100000-0000-4000-8000-000000000002';
  perform public.planner_apply_changes(jsonb_build_array(jsonb_build_object('table','projects','action','update','expectedUpdatedAt',revision,'row',jsonb_build_object('id','95100000-0000-4000-8000-000000000002','icon',null))));
  if not exists(select 1 from public.projects where id='95100000-0000-4000-8000-000000000002' and icon is null and completed_at is not null) then raise exception 'Default reset'; end if;
end $$;
select set_config('test.project_icon_revision',(select updated_at::text from public.projects where id='95100000-0000-4000-8000-000000000002'),true);
select set_config('request.jwt.claim.sub','95000000-0000-4000-8000-000000000002',true);
do $$ begin
  if exists(select 1 from public.projects where id in ('95100000-0000-4000-8000-000000000001','95100000-0000-4000-8000-000000000002')) then raise exception 'Foreign icon read'; end if;
  begin
    perform public.planner_apply_changes(jsonb_build_array(jsonb_build_object('table','projects','action','update','expectedUpdatedAt',current_setting('test.project_icon_revision'),'row',jsonb_build_object('id','95100000-0000-4000-8000-000000000002','icon','heart'))));
    raise exception 'Foreign icon update';
  exception when sqlstate 'PT409' then null; end;
end $$;
set local role anon;
do $$ begin
  begin perform public.planner_load_workspace(); raise exception 'Anonymous workspace'; exception when insufficient_privilege then null; end;
end $$;
rollback;
select 9 as passed_checks;
