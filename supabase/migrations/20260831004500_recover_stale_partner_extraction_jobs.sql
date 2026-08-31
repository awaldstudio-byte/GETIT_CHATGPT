create or replace function public.claim_partner_application_extraction_job_v1(
  p_worker_id text default 'local-document-worker'
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  job public.partner_application_extraction_jobs%rowtype;
  result jsonb;
begin
  perform private.assert_messaging_service_role();

  select * into job
  from public.partner_application_extraction_jobs
  where attempts < 3
    and (
      status in ('pending','failed')
      or (status='processing' and claimed_at < now() - interval '25 minutes')
    )
  order by requested_at,id
  limit 1
  for update skip locked;

  if not found then return null; end if;

  update public.partner_application_extraction_jobs
  set status='processing',attempts=attempts+1,
      worker_id=left(coalesce(nullif(btrim(p_worker_id),''),'local-document-worker'),120),
      claimed_at=now(),completed_at=null,error_code=null
  where id=job.id
  returning * into job;

  select jsonb_build_object(
    'job_id',job.id,
    'application_id',job.application_id,
    'attempt',job.attempts,
    'files',coalesce(jsonb_agg(jsonb_build_object(
      'file_id',f.id,
      'attachment_id',a.id,
      'mime_type',split_part(lower(coalesce(a.mime_type,'')),';',1),
      'file_name',a.file_name,
      'storage_bucket',a.storage_bucket,
      'storage_path',a.storage_path
    ) order by f.created_at,f.id) filter (where f.id is not null),'[]'::jsonb)
  ) into result
  from public.partner_application_files f
  join public.messaging_attachments a on a.id=f.attachment_id
  where f.application_id=job.application_id
    and a.retrieval_status='available'
    and a.storage_bucket is not null and a.storage_path is not null
    and split_part(lower(coalesce(a.mime_type,'')),';',1)
      in ('application/pdf','image/jpeg','image/png','image/webp');

  return result;
end;
$$;

revoke all on function public.claim_partner_application_extraction_job_v1(text)
from public,anon,authenticated;
grant execute on function public.claim_partner_application_extraction_job_v1(text)
to service_role;

comment on function public.claim_partner_application_extraction_job_v1(text) is
  'Claims pending or failed document extraction work and safely reclaims a processing lease after 25 minutes.';
