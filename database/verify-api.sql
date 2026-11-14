-- Rollback-only API verification. No fixture records or authentication users survive.
begin;
insert into auth.users(id,email) values
 ('90000000-0000-4000-8000-000000000001','planner-api-owner@example.invalid'),
 ('90000000-0000-4000-8000-000000000002','planner-api-other@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}',true);

select public.planner_apply_changes(jsonb_build_array(
 jsonb_build_object('table','projects','action','insert','row',jsonb_build_object('id','91000000-0000-4000-8000-000000000001','title','API project')),
 jsonb_build_object('table','tasks','action','insert','row',jsonb_build_object('id','91000000-0000-4000-8000-000000000002','title','API task','project_id','91000000-0000-4000-8000-000000000001')),
 jsonb_build_object('table','task_completion_conditions','action','insert','row',jsonb_build_object('id','91000000-0000-4000-8000-000000000003','task_id','91000000-0000-4000-8000-000000000002','description','Deliver')),
 jsonb_build_object('table','thoughts','action','insert','row',jsonb_build_object('id','91000000-0000-4000-8000-000000000004','content','Keep the source')),
 jsonb_build_object('table','thought_task_links','action','insert','row',jsonb_build_object('thought_id','91000000-0000-4000-8000-000000000004','task_id','91000000-0000-4000-8000-000000000002')),
 jsonb_build_object('table','time_blocks','action','insert','row',jsonb_build_object('id','91000000-0000-4000-8000-000000000005','starts_at','2026-10-23T01:00:00Z','ends_at','2026-10-23T01:30:00Z')),
 jsonb_build_object('table','time_block_tasks','action','insert','row',jsonb_build_object('time_block_id','91000000-0000-4000-8000-000000000005','task_id','91000000-0000-4000-8000-000000000002'))
));
-- 1. Atomic create plus retained source and time links.
do $$ declare s jsonb := public.planner_load_workspace(); begin
 if jsonb_array_length(s->'tasks')<>1 or jsonb_array_length(s->'thoughts')<>1 or jsonb_array_length(s->'thought_task_links')<>1 or jsonb_array_length(s->'time_block_tasks')<>1 then raise exception 'Atomic create mismatch'; end if;
end $$;
-- 2. The mutation API cannot complete a task with an unmet condition.
do $$ begin begin
 perform public.planner_apply_changes((select jsonb_build_array(jsonb_build_object('table','tasks','action','update','row',(to_jsonb(t)-'owner_id')||jsonb_build_object('completed_at',now()),'expectedUpdatedAt',t.updated_at)) from public.tasks t where id='91000000-0000-4000-8000-000000000002'));
 raise exception 'Expected unmet-condition gate'; exception when check_violation then null; end; end $$;
select public.planner_apply_changes((select jsonb_build_array(jsonb_build_object('table','task_completion_conditions','action','update','row',(to_jsonb(t)-'owner_id')||jsonb_build_object('is_met',true),'expectedUpdatedAt',t.updated_at)) from public.task_completion_conditions t where id='91000000-0000-4000-8000-000000000003'));
-- 3. Checking the last condition never completes the task automatically.
do $$ begin if exists(select 1 from public.tasks where id='91000000-0000-4000-8000-000000000002' and completed_at is not null) then raise exception 'Unexpected automatic completion'; end if; end $$;
select public.planner_apply_changes((select jsonb_build_array(jsonb_build_object('table','tasks','action','update','row',(to_jsonb(t)-'owner_id')||jsonb_build_object('completed_at',now()),'expectedUpdatedAt',t.updated_at)) from public.tasks t where id='91000000-0000-4000-8000-000000000002'));
select public.planner_apply_changes((select jsonb_build_array(jsonb_build_object('table','projects','action','update','row',(to_jsonb(t)-'owner_id')||jsonb_build_object('completed_at',now()),'expectedUpdatedAt',t.updated_at)) from public.projects t where id='91000000-0000-4000-8000-000000000001'));
-- 4. Explicit confirmation succeeds through the API.
do $$ begin if not exists(select 1 from public.projects where id='91000000-0000-4000-8000-000000000001' and completed_at is not null) then raise exception 'Manual confirmation failed'; end if; end $$;
select public.planner_apply_changes((select jsonb_build_array(jsonb_build_object('table','task_completion_conditions','action','update','row',(to_jsonb(t)-'owner_id')||jsonb_build_object('is_met',false),'expectedUpdatedAt',t.updated_at)) from public.task_completion_conditions t where id='91000000-0000-4000-8000-000000000003'));
-- 5. Database triggers reopen both levels without trusting client-side state.
do $$ begin if exists(select 1 from public.tasks where id='91000000-0000-4000-8000-000000000002' and completed_at is not null) or exists(select 1 from public.projects where id='91000000-0000-4000-8000-000000000001' and completed_at is not null) then raise exception 'Reopening failed'; end if; end $$;
-- 6. A bad final link rolls back the whole API call.
do $$ begin begin
 perform public.planner_apply_changes(jsonb_build_array(
  jsonb_build_object('table','thoughts','action','insert','row',jsonb_build_object('id','91000000-0000-4000-8000-000000000006','content','Must roll back')),
  jsonb_build_object('table','thought_task_links','action','insert','row',jsonb_build_object('thought_id','91000000-0000-4000-8000-000000000006','task_id','91000000-0000-4000-8000-000000000099'))
 )); raise exception 'Expected invalid-link rejection'; exception when foreign_key_violation then null; end;
 if exists(select 1 from public.thoughts where id='91000000-0000-4000-8000-000000000006') then raise exception 'Partial write survived'; end if;
end $$;
-- 7. Stale revisions cannot overwrite a newer edit.
do $$ declare stale jsonb; begin
 select jsonb_build_array(jsonb_build_object('table','tasks','action','update','row',(to_jsonb(t)-'owner_id')||jsonb_build_object('title','Stale'),'expectedUpdatedAt',t.updated_at)) into stale from public.tasks t where id='91000000-0000-4000-8000-000000000002';
 update public.tasks set title='Fresh' where id='91000000-0000-4000-8000-000000000002';
 begin perform public.planner_apply_changes(stale); raise exception 'Expected stale rejection'; exception when sqlstate 'PT409' then null; end;
 if not exists(select 1 from public.tasks where id='91000000-0000-4000-8000-000000000002' and title='Fresh') then raise exception 'Fresh edit overwritten'; end if;
end $$;
-- 8. Owner injection is rejected before mutation.
do $$ begin begin perform public.planner_apply_changes('[{"table":"thoughts","action":"insert","row":{"id":"91000000-0000-4000-8000-000000000007","content":"Wrong owner","owner_id":"90000000-0000-4000-8000-000000000002"}}]'::jsonb); raise exception 'Expected owner rejection'; exception when invalid_parameter_value then null; end; end $$;
select set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
-- 9. Another account sees no records and cannot mutate a foreign record.
do $$ begin
 if jsonb_array_length(public.planner_load_workspace()->'tasks')<>0 then raise exception 'Cross-account read'; end if;
 begin perform public.planner_apply_changes('[{"table":"tasks","action":"delete","row":{"id":"91000000-0000-4000-8000-000000000002"},"expectedUpdatedAt":"2026-10-23T00:00:00Z"}]'::jsonb); raise exception 'Expected foreign-record rejection'; exception when sqlstate 'PT409' then null; end;
end $$;
reset role;
-- 10. Invoker functions keep anonymous callers out and use a fixed empty search path.
do $$ begin if has_function_privilege('anon','public.planner_load_workspace()','execute') or has_function_privilege('anon','public.planner_apply_changes(jsonb)','execute') or exists(select 1 from pg_proc where oid in ('public.planner_load_workspace()'::regprocedure,'public.planner_apply_changes(jsonb)'::regprocedure) and (prosecdef or not proconfig @> array['search_path=""'])) then raise exception 'API privilege mismatch'; end if; end $$;
rollback;
select 10 as passed_checks, 'API checks passed; fixtures rolled back' as result;
