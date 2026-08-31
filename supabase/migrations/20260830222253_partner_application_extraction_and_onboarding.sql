-- Reliable partner-form extraction, optional-aware staff review, and a
-- no-send guided-onboarding checklist. Approval still never activates a shop.

create table if not exists public.partner_application_field_definitions (
  application_type text not null check (application_type in ('shop','driver')),
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]{1,79}$'),
  field_label text not null check (length(field_label) between 1 and 160),
  section_key text not null check (section_key ~ '^[a-z][a-z0-9_]{1,49}$'),
  requirement_level text not null check (requirement_level in ('required','conditional','optional')),
  sort_order integer not null check (sort_order between 1 and 1000),
  primary key (application_type, field_key)
);

insert into public.partner_application_field_definitions
  (application_type,field_key,field_label,section_key,requirement_level,sort_order)
values
  ('shop','shop_trading_name','Shop / trading name','quick_application','required',10),
  ('shop','application_date','Application date','quick_application','optional',20),
  ('shop','authorised_representative','Owner / authorised representative','quick_application','required',30),
  ('shop','primary_mobile','Primary WhatsApp / mobile','quick_application','required',40),
  ('shop','email_address','Email address','quick_application','optional',50),
  ('shop','preferred_language','Preferred language','quick_application','optional',60),
  ('shop','shop_address','Full shop address','quick_application','required',70),
  ('shop','business_types','Business type','shop_profile','required',100),
  ('shop','business_type_other','Other business type','shop_profile','conditional',110),
  ('shop','legal_registered_name','Legal / registered name','shop_profile','optional',120),
  ('shop','registration_number','Registration number','shop_profile','optional',130),
  ('shop','vat_number','VAT number','shop_profile','optional',140),
  ('shop','business_structure','Independent / franchise / other','shop_profile','optional',150),
  ('shop','alternative_contact','Alternative contact','shop_profile','optional',160),
  ('shop','alternative_phone','Alternative telephone','shop_profile','optional',170),
  ('shop','products_services_description','Products or services sold','shop_profile','required',180),
  ('shop','retail_acknowledgements','Normal retail transaction acknowledgements','shop_profile','required',190),
  ('shop','trading_hours','Public trading hours','hours','required',200),
  ('shop','closure_days','Regular closure days','hours','optional',210),
  ('shop','closure_times','Regular closure times','hours','optional',220),
  ('shop','closure_reason','Closure reason','hours','optional',230),
  ('shop','closure_seasonal_notes','Seasonal closure notes','hours','optional',240),
  ('shop','holiday_emergency_closures','Holiday / emergency closure arrangements','hours','optional',250),
  ('shop','catalogue_supply','Catalogue material supplied','catalogue','optional',300),
  ('shop','catalogue_file_formats','Catalogue file formats','catalogue','optional',310),
  ('shop','catalogue_update_cadence','Catalogue update preference','catalogue','optional',320),
  ('shop','applicant_name','Applicant name','agreement','required',400),
  ('shop','applicant_capacity','Applicant capacity / role','agreement','required',410),
  ('shop','applicant_signature','Applicant signature or typed name','agreement','required',420),
  ('shop','signature_date','Signature date','agreement','required',430)
on conflict (application_type,field_key) do update set
  field_label=excluded.field_label,
  section_key=excluded.section_key,
  requirement_level=excluded.requirement_level,
  sort_order=excluded.sort_order;

create table if not exists public.partner_application_field_values (
  application_id uuid not null references public.partner_applications(id) on delete cascade,
  field_key text not null,
  value_text text,
  value_json jsonb,
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  extraction_method text not null default 'manual'
    check (extraction_method in ('acroform','vision','manual','conversation')),
  verification_status text not null default 'pending_staff'
    check (verification_status in ('pending_staff','verified','rejected')),
  source_file_id uuid references public.partner_application_files(id) on delete set null,
  source_page integer check (source_page is null or source_page between 1 and 100),
  evidence_text text check (evidence_text is null or length(evidence_text)<=500),
  staff_note text check (staff_note is null or length(staff_note)<=2000),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  version bigint not null default 1 check (version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (application_id,field_key),
  check (value_text is not null or value_json is not null)
);

create index if not exists partner_application_field_values_review_idx
  on public.partner_application_field_values(application_id,verification_status,field_key);

drop trigger if exists partner_application_field_values_set_updated_at on public.partner_application_field_values;
create trigger partner_application_field_values_set_updated_at
before update on public.partner_application_field_values
for each row execute function public.set_updated_at();

create table if not exists public.partner_application_extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.partner_applications(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed','cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  worker_id text,
  error_code text check (error_code is null or length(error_code)<=160),
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists partner_application_extraction_jobs_claim_idx
  on public.partner_application_extraction_jobs(status,requested_at,id)
  where status in ('pending','failed');

drop trigger if exists partner_application_extraction_jobs_set_updated_at on public.partner_application_extraction_jobs;
create trigger partner_application_extraction_jobs_set_updated_at
before update on public.partner_application_extraction_jobs
for each row execute function public.set_updated_at();

create table if not exists public.partner_onboarding_requirements (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.partner_applications(id) on delete cascade,
  requirement_key text not null check (requirement_key ~ '^[a-z][a-z0-9_]{1,79}$'),
  title text not null check (length(title) between 1 and 160),
  requirement_level text not null check (requirement_level in ('required','conditional','optional')),
  status text not null default 'not_started'
    check (status in ('not_started','requested','needs_guidance','partial','received_pending_review','verified','not_applicable','blocked','completed')),
  guidance text check (guidance is null or length(guidance)<=2000),
  current_value text check (current_value is null or length(current_value)<=4000),
  staff_note text check (staff_note is null or length(staff_note)<=2000),
  sort_order integer not null check (sort_order between 1 and 1000),
  requested_at timestamptz,
  completed_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  version bigint not null default 1 check (version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(application_id,requirement_key)
);

create index if not exists partner_onboarding_requirements_application_idx
  on public.partner_onboarding_requirements(application_id,sort_order,id);

drop trigger if exists partner_onboarding_requirements_set_updated_at on public.partner_onboarding_requirements;
create trigger partner_onboarding_requirements_set_updated_at
before update on public.partner_onboarding_requirements
for each row execute function public.set_updated_at();

alter table public.partner_application_field_definitions enable row level security;
alter table public.partner_application_field_values enable row level security;
alter table public.partner_application_extraction_jobs enable row level security;
alter table public.partner_onboarding_requirements enable row level security;

drop policy if exists "operations staff view partner field definitions" on public.partner_application_field_definitions;
create policy "operations staff view partner field definitions"
on public.partner_application_field_definitions for select to authenticated
using ((select public.current_staff_role()) in ('owner','admin','dispatcher'));

drop policy if exists "operations staff view partner field values" on public.partner_application_field_values;
create policy "operations staff view partner field values"
on public.partner_application_field_values for select to authenticated
using ((select public.current_staff_role()) in ('owner','admin','dispatcher'));

drop policy if exists "operations staff view partner extraction jobs" on public.partner_application_extraction_jobs;
create policy "operations staff view partner extraction jobs"
on public.partner_application_extraction_jobs for select to authenticated
using ((select public.current_staff_role()) in ('owner','admin','dispatcher'));

drop policy if exists "operations staff view onboarding requirements" on public.partner_onboarding_requirements;
create policy "operations staff view onboarding requirements"
on public.partner_onboarding_requirements for select to authenticated
using ((select public.current_staff_role()) in ('owner','admin','dispatcher'));

create or replace function public.queue_partner_application_extraction_v1(p_application_id uuid)
returns public.partner_application_extraction_jobs
language plpgsql security definer set search_path=''
as $$
declare
  application public.partner_applications%rowtype;
  job public.partner_application_extraction_jobs%rowtype;
begin
  if public.current_staff_role() not in ('owner','admin','dispatcher') then
    raise exception 'operations staff role required' using errcode='42501';
  end if;
  select * into application from public.partner_applications where id=p_application_id;
  if not found then raise exception 'application not found' using errcode='P0002'; end if;
  if application.application_type<>'shop' then
    raise exception 'form extraction is currently available for shop applications' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.partner_application_files f
    join public.messaging_attachments a on a.id=f.attachment_id
    where f.application_id=p_application_id
      and a.retrieval_status='available'
      and a.storage_bucket is not null and a.storage_path is not null
      and split_part(lower(coalesce(a.mime_type,'')),';',1) in ('application/pdf','image/jpeg','image/png','image/webp')
  ) then
    raise exception 'no archived PDF or image is available for extraction' using errcode='55000';
  end if;
  insert into public.partner_application_extraction_jobs(application_id,status,attempts,requested_by,requested_at,error_code,claimed_at,completed_at,worker_id)
  values(p_application_id,'pending',0,auth.uid(),now(),null,null,null,null)
  on conflict(application_id) do update set
    status='pending',attempts=0,requested_by=auth.uid(),requested_at=now(),error_code=null,
    claimed_at=null,completed_at=null,worker_id=null
  returning * into job;
  return job;
end;
$$;

create or replace function public.claim_partner_application_extraction_job_v1(p_worker_id text default 'local-document-worker')
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  job public.partner_application_extraction_jobs%rowtype;
  result jsonb;
begin
  perform private.assert_messaging_service_role();
  select * into job
  from public.partner_application_extraction_jobs
  where status in ('pending','failed') and attempts<3
  order by requested_at,id
  limit 1
  for update skip locked;
  if not found then return null; end if;
  update public.partner_application_extraction_jobs
  set status='processing',attempts=attempts+1,worker_id=left(coalesce(nullif(btrim(p_worker_id),''),'local-document-worker'),120),
      claimed_at=now(),error_code=null
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
    and split_part(lower(coalesce(a.mime_type,'')),';',1) in ('application/pdf','image/jpeg','image/png','image/webp');
  return result;
end;
$$;

create or replace function public.complete_partner_application_extraction_job_v1(
  p_job_id uuid,
  p_ok boolean,
  p_fields jsonb default '[]'::jsonb,
  p_error_code text default null
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  job public.partner_application_extraction_jobs%rowtype;
  item jsonb;
  definition public.partner_application_field_definitions%rowtype;
  source_file uuid;
  inserted_count integer:=0;
begin
  perform private.assert_messaging_service_role();
  select * into job from public.partner_application_extraction_jobs where id=p_job_id for update;
  if not found then raise exception 'extraction job not found' using errcode='P0002'; end if;
  if job.status<>'processing' then raise exception 'extraction job is not processing' using errcode='55000'; end if;
  if p_ok and (jsonb_typeof(coalesce(p_fields,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_fields,'[]'::jsonb))>40) then
    raise exception 'invalid extraction field payload' using errcode='22023';
  end if;

  if p_ok then
    for item in select value from jsonb_array_elements(coalesce(p_fields,'[]'::jsonb)) loop
      select * into definition
      from public.partner_application_field_definitions
      where application_type='shop' and field_key=item->>'field_key';
      if not found then continue; end if;
      begin source_file:=nullif(item->>'source_file_id','')::uuid;
      exception when others then source_file:=null; end;
      if source_file is not null and not exists (
        select 1 from public.partner_application_files f
        where f.id=source_file and f.application_id=job.application_id
      ) then source_file:=null; end if;
      if nullif(btrim(coalesce(item->>'value_text','')),'') is null
         and coalesce(item->'value_json','null'::jsonb) in ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'""'::jsonb) then
        continue;
      end if;
      if pg_column_size(coalesce(item->'value_json','null'::jsonb))>65536 then continue; end if;

      insert into public.partner_application_field_values(
        application_id,field_key,value_text,value_json,confidence,extraction_method,
        verification_status,source_file_id,source_page,evidence_text
      ) values (
        job.application_id,definition.field_key,left(nullif(btrim(coalesce(item->>'value_text','')),''),4000),
        nullif(item->'value_json','null'::jsonb),
        greatest(0,least(1,case when coalesce(item->>'confidence','') ~ '^(0(?:\.[0-9]+)?|1(?:\.0+)?)$'
                                  then (item->>'confidence')::numeric else 0 end)),
        case when item->>'extraction_method'='acroform' then 'acroform' else 'vision' end,
        'pending_staff',source_file,
        case when coalesce(item->>'source_page','') ~ '^[0-9]{1,2}$'
                  and (item->>'source_page')::integer between 1 and 100
             then (item->>'source_page')::integer else null end,
        left(nullif(btrim(coalesce(item->>'evidence_text','')),''),500)
      )
      on conflict(application_id,field_key) do update set
        value_text=excluded.value_text,value_json=excluded.value_json,confidence=excluded.confidence,
        extraction_method=excluded.extraction_method,verification_status='pending_staff',
        source_file_id=excluded.source_file_id,source_page=excluded.source_page,
        evidence_text=excluded.evidence_text,staff_note=null,reviewed_by=null,reviewed_at=null,
        version=public.partner_application_field_values.version+1;
      inserted_count:=inserted_count+1;
    end loop;
  end if;

  update public.partner_application_extraction_jobs
  set status=case when p_ok then 'completed' else 'failed' end,
      error_code=case when p_ok then null else left(coalesce(nullif(btrim(p_error_code),''),'EXTRACTION_FAILED'),160) end,
      completed_at=case when p_ok then now() else null end
  where id=job.id;
  return jsonb_build_object('ok',p_ok,'job_id',job.id,'application_id',job.application_id,'field_count',inserted_count);
end;
$$;

create or replace function public.review_partner_application_field_v1(
  p_application_id uuid,
  p_field_key text,
  p_value_text text,
  p_value_json jsonb,
  p_verification_status text,
  p_staff_note text,
  p_expected_version bigint
) returns public.partner_application_field_values
language plpgsql security definer set search_path=''
as $$
declare
  field_value public.partner_application_field_values%rowtype;
  role_name text:=public.current_staff_role();
  application_type_name text;
  definition_exists boolean;
begin
  if role_name not in ('owner','admin','dispatcher') then
    raise exception 'operations staff role required' using errcode='42501';
  end if;
  if p_verification_status not in ('pending_staff','verified','rejected') then
    raise exception 'invalid field review status' using errcode='22023';
  end if;
  if p_verification_status='verified' and nullif(btrim(coalesce(p_value_text,'')),'') is null
     and coalesce(p_value_json,'null'::jsonb) in ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'""'::jsonb) then
    raise exception 'a verified field needs a value' using errcode='22023';
  end if;
  if pg_column_size(coalesce(p_value_json,'null'::jsonb))>65536 then
    raise exception 'field value is too large' using errcode='22023';
  end if;

  select a.application_type into application_type_name
  from public.partner_applications a where a.id=p_application_id;
  if not found then raise exception 'application not found' using errcode='P0002'; end if;
  select exists(
    select 1 from public.partner_application_field_definitions d
    where d.application_type=application_type_name and d.field_key=p_field_key
  ) into definition_exists;
  if not definition_exists then raise exception 'unknown application field' using errcode='22023'; end if;

  select * into field_value
  from public.partner_application_field_values
  where application_id=p_application_id and field_key=p_field_key
  for update;

  if not found then
    if coalesce(p_expected_version,0)<>0 then
      raise exception 'field changed; refresh before reviewing' using errcode='40001';
    end if;
    if nullif(btrim(coalesce(p_value_text,'')),'') is null
       and coalesce(p_value_json,'null'::jsonb) in ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'""'::jsonb) then
      raise exception 'a new field needs a value' using errcode='22023';
    end if;
    insert into public.partner_application_field_values(
      application_id,field_key,value_text,value_json,confidence,extraction_method,
      verification_status,staff_note,reviewed_by,reviewed_at
    ) values(
      p_application_id,p_field_key,left(nullif(btrim(coalesce(p_value_text,'')),''),4000),
      nullif(p_value_json,'null'::jsonb),1,'manual',p_verification_status,
      left(nullif(btrim(coalesce(p_staff_note,'')),''),2000),auth.uid(),now()
    ) returning * into field_value;
  else
    if field_value.version<>p_expected_version then
      raise exception 'field changed; refresh before reviewing' using errcode='40001';
    end if;

    update public.partner_application_field_values
    set value_text=left(nullif(btrim(coalesce(p_value_text,'')),''),4000),
        value_json=nullif(p_value_json,'null'::jsonb),
        extraction_method=case when value_text is distinct from left(nullif(btrim(coalesce(p_value_text,'')),''),4000)
                                    or value_json is distinct from nullif(p_value_json,'null'::jsonb)
                               then 'manual' else extraction_method end,
        verification_status=p_verification_status,
        staff_note=left(nullif(btrim(coalesce(p_staff_note,'')),''),2000),
        reviewed_by=auth.uid(),reviewed_at=now(),version=version+1
    where application_id=p_application_id and field_key=p_field_key
    returning * into field_value;
  end if;

  if p_verification_status='verified' then
    update public.partner_applications
    set business_name=case when p_field_key='shop_trading_name' then field_value.value_text else business_name end,
        applicant_name=case when p_field_key in ('authorised_representative','applicant_name') then field_value.value_text else applicant_name end,
        business_type=case when p_field_key='business_types' then field_value.value_text else business_type end,
        location_text=case when p_field_key='shop_address' then field_value.value_text else location_text end,
        version=version+1
    where id=p_application_id;
  end if;
  return field_value;
end;
$$;

create or replace function public.review_partner_application_v3(
  p_application_id uuid,
  p_new_status text,
  p_review_note text,
  p_expected_version bigint
) returns public.partner_applications
language plpgsql security definer set search_path=''
as $$
declare
  application public.partner_applications%rowtype;
  staff_role text:=public.current_staff_role();
  actor uuid:=auth.uid();
begin
  if staff_role not in ('owner','admin','dispatcher') then
    raise exception 'operations staff role required' using errcode='42501';
  end if;
  if p_new_status not in ('reviewing','approved','rejected') then
    raise exception 'invalid application review status' using errcode='22023';
  end if;
  if p_new_status in ('approved','rejected') and staff_role not in ('owner','admin') then
    raise exception 'owner or admin approval required' using errcode='42501';
  end if;
  if p_review_note is null or btrim(p_review_note)='' then
    raise exception 'private review note is required' using errcode='22023';
  end if;
  select * into application from public.partner_applications where id=p_application_id for update;
  if not found then raise exception 'application not found' using errcode='P0002'; end if;
  if application.version<>p_expected_version then
    raise exception 'application changed; refresh before reviewing' using errcode='40001';
  end if;
  if application.status not in ('submitted','reviewing') then
    raise exception 'application is not awaiting a review decision' using errcode='55000';
  end if;
  if p_new_status='approved' and application.application_type='shop' and exists (
    select 1
    from public.partner_application_field_definitions d
    where d.application_type='shop' and d.requirement_level='required'
      and not exists (
        select 1 from public.partner_application_field_values v
        where v.application_id=application.id and v.field_key=d.field_key
          and v.verification_status='verified'
          and (nullif(btrim(coalesce(v.value_text,'')),'') is not null
               or coalesce(v.value_json,'null'::jsonb) not in ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'""'::jsonb))
      )
  ) then
    raise exception 'verify the required application fields before approval' using errcode='55000';
  end if;

  update public.partner_applications
  set status=p_new_status,
      current_step=case when p_new_status='reviewing' then 'staff_review'
                        when p_new_status='approved' then 'guided_onboarding_ready'
                        else 'review_complete' end,
      assigned_staff_user_id=case when p_new_status='reviewing' then actor else assigned_staff_user_id end,
      review_note=left(btrim(p_review_note),2000),
      reviewed_by=case when p_new_status in ('approved','rejected') then actor else reviewed_by end,
      reviewed_at=case when p_new_status in ('approved','rejected') then now() else reviewed_at end,
      answers=case when p_new_status='approved' then answers||jsonb_build_object(
        'onboarding',jsonb_build_object('state','ready','customer_messaging_started',false,'prepared_at',now())
      ) else answers end,
      version=version+1
  where id=p_application_id and version=p_expected_version
  returning * into application;
  if not found then raise exception 'application changed; refresh before reviewing' using errcode='40001'; end if;

  if p_new_status='approved' and application.application_type='shop' then
    insert into public.partner_onboarding_requirements(
      application_id,requirement_key,title,requirement_level,status,guidance,sort_order,updated_by
    ) values
      (application.id,'shop_identity','Confirm the shop identity','required','received_pending_review','Confirm the trading name and authorised contact without asking for optional company registration details.',10,actor),
      (application.id,'operating_address','Confirm where the shop operates','required','received_pending_review','Accept a clear Villiers/Qalabotjha address or location pin and answer questions about how it will be used.',20,actor),
      (application.id,'public_hours','Confirm public trading hours','required','received_pending_review','Ask only for missing days or unclear times. Explain that Getit shops during public hours and avoids marked closures.',30,actor),
      (application.id,'products_services','Understand what the shop sells','required','received_pending_review','Confirm the main categories in plain language. Restricted categories stay off until a separate review.',40,actor),
      (application.id,'catalogue_preference','Choose the easiest catalogue option','optional','not_started','Offer simple choices one at a time: existing PDF or flyer, photos, spreadsheet, website/menu link, or no catalogue and shop-on-request.',50,actor),
      (application.id,'catalogue_material','Receive stock list or pricing material','optional','not_started','Help the shop send what it already has. Do not require a custom catalogue or live stock feed.',60,actor),
      (application.id,'restricted_category_review','Review any restricted categories','conditional','not_applicable','Only start this separate review if the shop asks to include regulated goods. Never activate them from the general form.',70,actor),
      (application.id,'written_activation','Send written activation confirmation','required','not_started','Staff-only final step after operating details are verified. Approval and onboarding preparation do not activate the shop.',90,actor)
    on conflict(application_id,requirement_key) do nothing;
  end if;
  return application;
end;
$$;

create or replace function public.update_partner_onboarding_requirement_v1(
  p_requirement_id uuid,
  p_status text,
  p_current_value text,
  p_staff_note text,
  p_expected_version bigint
) returns public.partner_onboarding_requirements
language plpgsql security definer set search_path=''
as $$
declare requirement public.partner_onboarding_requirements%rowtype;
begin
  if public.current_staff_role() not in ('owner','admin','dispatcher') then
    raise exception 'operations staff role required' using errcode='42501';
  end if;
  if p_status not in ('not_started','requested','needs_guidance','partial','received_pending_review','verified','not_applicable','blocked','completed') then
    raise exception 'invalid onboarding status' using errcode='22023';
  end if;
  update public.partner_onboarding_requirements
  set status=p_status,current_value=left(nullif(btrim(coalesce(p_current_value,'')),''),4000),
      staff_note=left(nullif(btrim(coalesce(p_staff_note,'')),''),2000),updated_by=auth.uid(),
      requested_at=case when p_status='requested' and requested_at is null then now() else requested_at end,
      completed_at=case when p_status in ('verified','not_applicable','completed') then now() else null end,
      version=version+1
  where id=p_requirement_id and version=p_expected_version
  returning * into requirement;
  if not found then raise exception 'onboarding item changed; refresh before updating' using errcode='40001'; end if;
  return requirement;
end;
$$;

create or replace function public.add_partner_onboarding_requirement_v1(
  p_application_id uuid,
  p_title text,
  p_requirement_level text default 'optional',
  p_guidance text default null
) returns public.partner_onboarding_requirements
language plpgsql security definer set search_path=''
as $$
declare
  application public.partner_applications%rowtype;
  requirement public.partner_onboarding_requirements%rowtype;
  next_order integer;
begin
  if public.current_staff_role() not in ('owner','admin','dispatcher') then
    raise exception 'operations staff role required' using errcode='42501';
  end if;
  if p_requirement_level not in ('required','conditional','optional') then
    raise exception 'invalid requirement level' using errcode='22023';
  end if;
  if nullif(btrim(coalesce(p_title,'')),'') is null then
    raise exception 'onboarding instruction is required' using errcode='22023';
  end if;
  select * into application from public.partner_applications where id=p_application_id;
  if not found then raise exception 'application not found' using errcode='P0002'; end if;
  if application.status<>'approved' then
    raise exception 'approve the application before adding onboarding instructions' using errcode='55000';
  end if;
  select least(989,coalesce(max(sort_order),80)+1) into next_order
  from public.partner_onboarding_requirements where application_id=p_application_id;
  insert into public.partner_onboarding_requirements(
    application_id,requirement_key,title,requirement_level,status,guidance,sort_order,updated_by
  ) values(
    p_application_id,'custom_'||replace(gen_random_uuid()::text,'-',''),left(btrim(p_title),160),
    p_requirement_level,'not_started',left(nullif(btrim(coalesce(p_guidance,'')),''),2000),next_order,auth.uid()
  ) returning * into requirement;
  return requirement;
end;
$$;

revoke all on table public.partner_application_field_definitions from public,anon,authenticated;
revoke all on table public.partner_application_field_values from public,anon,authenticated;
revoke all on table public.partner_application_extraction_jobs from public,anon,authenticated;
revoke all on table public.partner_onboarding_requirements from public,anon,authenticated;
grant select on table public.partner_application_field_definitions to authenticated;
grant select on table public.partner_application_field_values to authenticated;
grant select on table public.partner_application_extraction_jobs to authenticated;
grant select on table public.partner_onboarding_requirements to authenticated;
grant all on table public.partner_application_field_definitions to service_role;
grant all on table public.partner_application_field_values to service_role;
grant all on table public.partner_application_extraction_jobs to service_role;
grant all on table public.partner_onboarding_requirements to service_role;

revoke all on function public.queue_partner_application_extraction_v1(uuid) from public,anon;
grant execute on function public.queue_partner_application_extraction_v1(uuid) to authenticated,service_role;
revoke all on function public.claim_partner_application_extraction_job_v1(text) from public,anon,authenticated;
grant execute on function public.claim_partner_application_extraction_job_v1(text) to service_role;
revoke all on function public.complete_partner_application_extraction_job_v1(uuid,boolean,jsonb,text) from public,anon,authenticated;
grant execute on function public.complete_partner_application_extraction_job_v1(uuid,boolean,jsonb,text) to service_role;
revoke all on function public.review_partner_application_field_v1(uuid,text,text,jsonb,text,text,bigint) from public,anon;
grant execute on function public.review_partner_application_field_v1(uuid,text,text,jsonb,text,text,bigint) to authenticated,service_role;
revoke all on function public.review_partner_application_v3(uuid,text,text,bigint) from public,anon;
grant execute on function public.review_partner_application_v3(uuid,text,text,bigint) to authenticated,service_role;
revoke all on function public.update_partner_onboarding_requirement_v1(uuid,text,text,text,bigint) from public,anon;
grant execute on function public.update_partner_onboarding_requirement_v1(uuid,text,text,text,bigint) to authenticated,service_role;
revoke all on function public.add_partner_onboarding_requirement_v1(uuid,text,text,text) from public,anon;
grant execute on function public.add_partner_onboarding_requirement_v1(uuid,text,text,text) to authenticated,service_role;

do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='partner_application_field_values') then
    alter publication supabase_realtime add table public.partner_application_field_values;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='partner_application_extraction_jobs') then
    alter publication supabase_realtime add table public.partner_application_extraction_jobs;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='partner_onboarding_requirements') then
    alter publication supabase_realtime add table public.partner_onboarding_requirements;
  end if;
end;
$$;

comment on table public.partner_application_field_values is 'Staff-reviewable extraction candidates. Optional blank fields are never inserted or treated as blockers.';
comment on table public.partner_onboarding_requirements is 'Guided shop onboarding checklist. Optional rows never block readiness and no row authorizes customer messaging or activation.';
comment on function public.review_partner_application_v3(uuid,text,text,bigint) is 'Records staff review and prepares a no-send onboarding checklist. Approval does not activate or message the shop.';
