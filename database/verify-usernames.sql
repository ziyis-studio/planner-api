-- Rollback-only account/limiter checks; never create real accounts or passwords.
begin;
insert into auth.users(id,email) values
 ('92000000-0000-4000-8000-000000000001','username-owner@example.invalid'),
 ('92000000-0000-4000-8000-000000000002','username-other@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000001',true);
-- 1. An authenticated account can claim its own alias.
insert into public.account_profiles(user_id,username) values('92000000-0000-4000-8000-000000000001','planner_owner');
do $$ begin if (select username from public.account_profiles) <> 'planner_owner' then raise exception 'Own username missing'; end if; end $$;
-- 2. A claim cannot be made on another account's behalf.
do $$ begin begin
 insert into public.account_profiles(user_id,username) values('92000000-0000-4000-8000-000000000002','spoofed_owner');
 raise exception 'Expected owner rejection'; exception when insufficient_privilege then null; end; end $$;
-- 3. Direct writes cannot bypass canonical lowercase validation.
do $$ begin begin
 update public.account_profiles set username='UpperCase';
 raise exception 'Expected username format rejection'; exception when check_violation then null; end; end $$;
-- 4. Renaming works through the same upsert the client sends.
insert into public.account_profiles(user_id,username) values('92000000-0000-4000-8000-000000000001','planner_renamed')
on conflict(user_id) do update set user_id=excluded.user_id,username=excluded.username;
do $$ begin if (select username from public.account_profiles) <> 'planner_renamed' then raise exception 'Rename failed'; end if; end $$;
-- 5. Ownership cannot be transferred with UPDATE.
do $$ begin begin
 update public.account_profiles set user_id='92000000-0000-4000-8000-000000000002';
 raise exception 'Expected owner transfer rejection'; exception when insufficient_privilege then null; end; end $$;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000002',true);
-- 6. Another authenticated account cannot see the mapping.
do $$ begin if exists(select 1 from public.account_profiles) then raise exception 'Other profile leaked'; end if; end $$;
-- 7. Duplicate aliases are rejected.
do $$ begin begin
 insert into public.account_profiles(user_id,username) values('92000000-0000-4000-8000-000000000002','planner_renamed');
 raise exception 'Expected unique username rejection'; exception when unique_violation then null; end; end $$;
-- 8. Authenticated clients cannot reset or invoke the server limiter.
do $$ begin begin
 perform public.planner_consume_username_login_limit(repeat('a',64),repeat('b',64));
 raise exception 'Expected limiter permission rejection'; exception when insufficient_privilege then null; end; end $$;
reset role; set local role anon;
-- 9. Anonymous clients cannot read the mapping.
do $$ begin begin
 perform 1 from public.account_profiles;
 raise exception 'Expected anonymous mapping rejection'; exception when insufficient_privilege then null; end; end $$;
do $$ begin begin
 perform public.planner_consume_username_login_limit(repeat('a',64),repeat('b',64));
 raise exception 'Expected anonymous limiter rejection'; exception when insufficient_privilege then null; end; end $$;
reset role; set local role service_role;
-- 10. The server role can resolve a username and consume exactly eight attempts.
do $$ declare i integer; begin
 if (select user_id from public.account_profiles where username='planner_renamed') <> '92000000-0000-4000-8000-000000000001'::uuid then raise exception 'Server lookup failed'; end if;
 for i in 1..8 loop
  if not public.planner_consume_username_login_limit(repeat('a',64),repeat('b',64)) then raise exception 'Allowed attempt rejected'; end if;
 end loop;
 if public.planner_consume_username_login_limit(repeat('c',64),repeat('b',64)) then raise exception 'Username limit bypassed by new network'; end if;
end $$;
-- 11. Private buckets cannot store malformed identifiers.
do $$ begin begin
 perform public.planner_consume_username_login_limit('raw-ip','raw-username');
 raise exception 'Expected hashed-key validation'; exception when invalid_parameter_value then null; end; end $$;
-- 12. Old buckets are pruned, and a different username remains available.
insert into private.username_login_limits values('expired-verification-bucket',now()-interval '2 hours',1);
do $$ begin
 if not public.planner_consume_username_login_limit(repeat('c',64),repeat('d',64)) then raise exception 'Independent username blocked'; end if;
 if exists(select 1 from private.username_login_limits where bucket='expired-verification-bucket') then raise exception 'Expired bucket not pruned'; end if;
end $$;
-- 13. Changing usernames cannot bypass the per-network cap.
do $$ declare i integer; begin
 for i in 1..20 loop
  if not public.planner_consume_username_login_limit(repeat('e',64),lpad(to_hex(i+100),64,'0')) then raise exception 'Network allowance rejected'; end if;
 end loop;
 if public.planner_consume_username_login_limit(repeat('e',64),repeat('f',64)) then raise exception 'Network limit bypassed'; end if;
end $$;
-- 14. Rotating both network and username cannot bypass the global cap.
do $$ declare i integer; v_before integer; v_allowed integer:=0; begin
 select attempts into v_before from private.username_login_limits where bucket=extract(epoch from date_trunc('minute',statement_timestamp()))::bigint::text||':global';
 for i in 1..130 loop
  if public.planner_consume_username_login_limit(lpad(to_hex(i+2000),64,'0'),lpad(to_hex(i+3000),64,'0')) then v_allowed:=v_allowed+1; end if;
 end loop;
 if v_allowed<>120-coalesce(v_before,0) then raise exception 'Global limit mismatch'; end if;
end $$;
reset role;
rollback;
select 14 as passed_checks;
