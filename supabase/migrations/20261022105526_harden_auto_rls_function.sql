-- Supabase's optional automatic-RLS event trigger is internal DDL infrastructure.
-- Keep it working for its owner while removing default API-role execution rights.
begin;
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;
commit;
