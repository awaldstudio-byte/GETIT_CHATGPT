-- Re-extraction replaces only unverified machine candidates. Staff-verified
-- values are preserved even when a later pass cannot read the same field.

create or replace function public.prune_partner_application_extraction_candidates_v1(
  p_job_id uuid,
  p_field_keys jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  job public.partner_application_extraction_jobs%rowtype;
  removed_count integer:=0;
begin
  perform private.assert_messaging_service_role();
  select * into job from public.partner_application_extraction_jobs where id=p_job_id;
  if not found then raise exception 'extraction job not found' using errcode='P0002'; end if;
  if job.status<>'completed' then
    return jsonb_build_object('ok',false,'job_id',job.id,'removed_count',0,'reason','JOB_NOT_COMPLETED');
  end if;
  if jsonb_typeof(coalesce(p_field_keys,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_field_keys,'[]'::jsonb))>40 then
    raise exception 'invalid extraction field key payload' using errcode='22023';
  end if;
  delete from public.partner_application_field_values v
  where v.application_id=job.application_id
    and v.verification_status<>'verified'
    and not exists (
      select 1 from jsonb_array_elements_text(coalesce(p_field_keys,'[]'::jsonb)) key
      where key=v.field_key
    );
  get diagnostics removed_count=row_count;
  return jsonb_build_object('ok',true,'job_id',job.id,'application_id',job.application_id,'removed_count',removed_count);
end;
$$;

revoke all on function public.prune_partner_application_extraction_candidates_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.prune_partner_application_extraction_candidates_v1(uuid,jsonb) to service_role;

comment on function public.prune_partner_application_extraction_candidates_v1(uuid,jsonb) is 'Removes stale unverified machine candidates after a successful re-extraction while preserving staff-verified values.';
