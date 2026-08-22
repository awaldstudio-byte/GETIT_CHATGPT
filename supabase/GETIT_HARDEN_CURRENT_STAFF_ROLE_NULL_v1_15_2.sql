begin;

create or replace function public.current_staff_role()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (
      select sa.role
      from public.staff_accounts sa
      where sa.user_id = (select auth.uid())
        and sa.active = true
      limit 1
    ),
    'none'
  );
$function$;

comment on function public.current_staff_role() is
  'Returns the active Getit staff role, or the non-privileged sentinel none. The sentinel makes NOT IN authorization guards fail closed for unknown users.';

commit;
