begin;
insert into auth.users(id,email) values
 ('96000000-0000-4000-8000-000000000001','order-owner@example.invalid'),
 ('96000000-0000-4000-8000-000000000002','order-other@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','96000000-0000-4000-8000-000000000001',true);
insert into public.projects(id,title) values ('96100000-0000-4000-8000-000000000001','Order fixture');
insert into public.tasks(id,project_id,title) values
 ('96200000-0000-4000-8000-000000000001','96100000-0000-4000-8000-000000000001','One'),
 ('96200000-0000-4000-8000-000000000002','96100000-0000-4000-8000-000000000001','Two');
insert into public.task_completion_conditions(id,task_id,description,is_met,position) values
 ('96300000-0000-4000-8000-000000000001','96200000-0000-4000-8000-000000000001','First',true,0),
 ('96300000-0000-4000-8000-000000000002','96200000-0000-4000-8000-000000000001','Second',true,1);
update public.tasks set completed_at=now() where owner_id=auth.uid();
update public.projects set completed_at=now() where owner_id=auth.uid();
do $$ declare changes jsonb; before_row jsonb;
begin
  if exists(select 1 from public.tasks where owner_id=auth.uid() and project_position<>0) then raise exception 'Default position'; end if;
  select jsonb_agg(jsonb_build_object('table','tasks','action','update','expectedUpdatedAt',updated_at::text,'row',jsonb_build_object('id',id,'project_position',case when title='One' then 1 else 0 end))) into changes from public.tasks where owner_id=auth.uid();
  perform public.planner_apply_changes(changes);
  if (select array_agg(title order by project_position) from public.tasks where owner_id=auth.uid()) <> array['Two','One'] then raise exception 'Task order'; end if;
  if not (public.planner_load_workspace()->'tasks') @> '[{"title":"One","project_position":1}]'::jsonb then raise exception 'Load round trip'; end if;
  if exists(select 1 from public.tasks where owner_id=auth.uid() and completed_at is null) or exists(select 1 from public.projects where owner_id=auth.uid() and completed_at is null) then raise exception 'Task completion changed'; end if;
  select jsonb_agg(jsonb_build_object('table','task_completion_conditions','action','update','expectedUpdatedAt',updated_at::text,'row',jsonb_build_object('id',id,'position',1-position))) into changes from public.task_completion_conditions where owner_id=auth.uid();
  perform public.planner_apply_changes(changes);
  if (select array_agg(description order by position) from public.task_completion_conditions where owner_id=auth.uid()) <> array['Second','First'] or exists(select 1 from public.task_completion_conditions where owner_id=auth.uid() and not is_met) then raise exception 'Condition state changed'; end if;
  if exists(select 1 from public.tasks where owner_id=auth.uid() and completed_at is null) or exists(select 1 from public.projects where owner_id=auth.uid() and completed_at is null) then raise exception 'Condition completion changed'; end if;
  select to_jsonb(t) into before_row from public.tasks t where id='96200000-0000-4000-8000-000000000001';
  begin
    perform public.planner_apply_changes(jsonb_build_array(
      jsonb_build_object('table','tasks','action','update','expectedUpdatedAt',before_row->>'updated_at','row',jsonb_build_object('id',before_row->>'id','project_position',9)),
      jsonb_build_object('table','tasks','action','update','expectedUpdatedAt','2000-01-01T00:00:00Z','row',jsonb_build_object('id','96200000-0000-4000-8000-000000000002','project_position',0))));
    raise exception 'Stale reorder accepted';
  exception when sqlstate 'PT409' then null; end;
  if (select to_jsonb(t) from public.tasks t where id='96200000-0000-4000-8000-000000000001') <> before_row then raise exception 'Partial reorder persisted'; end if;
  begin
    perform public.planner_apply_changes(jsonb_build_array(jsonb_build_object('table','tasks','action','update','expectedUpdatedAt',before_row->>'updated_at','row',jsonb_build_object('id',before_row->>'id','project_position',-1))));
    raise exception 'Negative order accepted';
  exception when check_violation then null; end;
end $$;
select set_config('test.order_revision',(select updated_at::text from public.tasks where id='96200000-0000-4000-8000-000000000001'),true);
select set_config('request.jwt.claim.sub','96000000-0000-4000-8000-000000000002',true);
do $$ begin
  if exists(select 1 from public.tasks where id='96200000-0000-4000-8000-000000000001') then raise exception 'Foreign order read'; end if;
  begin
    perform public.planner_apply_changes(jsonb_build_array(jsonb_build_object('table','tasks','action','update','expectedUpdatedAt',current_setting('test.order_revision'),'row',jsonb_build_object('id','96200000-0000-4000-8000-000000000001','project_position',4))));
    raise exception 'Foreign order write';
  exception when sqlstate 'PT409' then null; end;
end $$;
set local role anon;
do $$ begin
  begin perform public.planner_load_workspace(); raise exception 'Anonymous order read'; exception when insufficient_privilege then null; end;
end $$;
rollback;
select 12 as passed_checks;
