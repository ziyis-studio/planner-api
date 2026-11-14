-- Rollback-only Notes access and relation checks; no fixture user or record survives.
begin;
insert into auth.users(id,email) values ('93000000-0000-4000-8000-000000000001','notes-owner@example.invalid'),('93000000-0000-4000-8000-000000000002','notes-other@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','93000000-0000-4000-8000-000000000001',true);
select public.planner_apply_changes('[{"table":"notes","action":"insert","row":{"id":"93100000-0000-4000-8000-000000000001","title":"First","content":"# Markdown"}},{"table":"notes","action":"insert","row":{"id":"93100000-0000-4000-8000-000000000002","title":"Second"}}]');
insert into public.note_links(note_id,target_note_id) values('93100000-0000-4000-8000-000000000001','93100000-0000-4000-8000-000000000002');
do $$ begin
 if jsonb_array_length(public.planner_load_workspace()->'notes')<>2 or jsonb_array_length(public.planner_load_workspace()->'note_links')<>1 then raise exception 'Notes roundtrip';end if;
 begin insert into public.note_links(note_id,target_note_id) values('93100000-0000-4000-8000-000000000001','93100000-0000-4000-8000-000000000001');raise exception 'Self link accepted';exception when check_violation then null;end;
 begin insert into public.note_links(note_id) values('93100000-0000-4000-8000-000000000001');raise exception 'Empty target accepted';exception when check_violation then null;end;
 begin insert into public.note_links(note_id,target_note_id) values('93100000-0000-4000-8000-000000000001','93100000-0000-4000-8000-000000000002');raise exception 'Duplicate accepted';exception when unique_violation then null;end;
 begin update public.notes set owner_id='93000000-0000-4000-8000-000000000002' where id='93100000-0000-4000-8000-000000000001';raise exception 'Owner mutation accepted';exception when check_violation or insufficient_privilege then null;end;
 begin perform public.planner_apply_changes('[{"table":"notes","action":"update","expectedUpdatedAt":"2000-01-01T00:00:00Z","row":{"id":"93100000-0000-4000-8000-000000000001","title":"Stale"}}]');raise exception 'Stale accepted';exception when sqlstate 'PT409' then null;end;
end $$;
select set_config('request.jwt.claim.sub','93000000-0000-4000-8000-000000000002',true);
insert into public.notes(id,title) values('93200000-0000-4000-8000-000000000001','Other');
do $$ declare changed integer; begin
 if exists(select 1 from public.notes where id='93100000-0000-4000-8000-000000000001') or exists(select 1 from public.note_links) then raise exception 'Foreign read';end if;
 begin insert into public.note_links(note_id,target_note_id) values('93100000-0000-4000-8000-000000000001','93200000-0000-4000-8000-000000000001');raise exception 'Foreign link';exception when foreign_key_violation then null;end;
 update public.notes set content='foreign edit' where id='93100000-0000-4000-8000-000000000001';get diagnostics changed=row_count;if changed<>0 then raise exception 'Foreign update';end if;
 delete from public.notes where id='93100000-0000-4000-8000-000000000001';get diagnostics changed=row_count;if changed<>0 then raise exception 'Foreign delete';end if;
end $$;
select set_config('request.jwt.claim.sub','93000000-0000-4000-8000-000000000001',true);
delete from public.notes where id='93100000-0000-4000-8000-000000000002';
do $$ begin if exists(select 1 from public.note_links) then raise exception 'Orphan association';end if;end $$;
set local role anon;
do $$ begin
 begin perform * from public.notes;raise exception 'Anonymous read';exception when insufficient_privilege then null;end;
 begin insert into public.notes(title) values('anon');raise exception 'Anonymous insert';exception when insufficient_privilege then null;end;
 begin update public.notes set content='anon';raise exception 'Anonymous update';exception when insufficient_privilege then null;end;
 begin delete from public.notes;raise exception 'Anonymous delete';exception when insufficient_privilege then null;end;
 begin perform * from public.note_links;raise exception 'Anonymous associations';exception when insufficient_privilege then null;end;
end $$;
rollback;
select 16 as passed_checks;
