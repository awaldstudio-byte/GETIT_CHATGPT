begin;

create or replace function public.verify_messaging_service_access()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.assert_messaging_service_role();
  return true;
end;
$function$;

comment on function public.verify_messaging_service_access() is
  'Side-effect-free service-key probe used by private Getit messaging workers. Never grant this function to customer or staff roles.';

revoke all on function public.verify_messaging_service_access() from public;
revoke all on function public.verify_messaging_service_access() from anon;
revoke all on function public.verify_messaging_service_access() from authenticated;
grant execute on function public.verify_messaging_service_access() to service_role;

commit;
