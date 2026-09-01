-- Getit staff waitlist override and permissioned operations supervisor.
-- The Supabase CLI is not installed on this workstation, so this migration
-- was created directly after `supabase migration new` could not be run.

create table if not exists public.supervisor_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete restrict,
  prompt text not null,
  status text not null default 'queued'
    check (status in ('queued','processing','completed','failed','cancelled')),
  priority smallint not null default 0 check (priority between 0 and 3),
  claim_token uuid,
  worker_id text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  operations_snapshot jsonb not null default '{}'::jsonb
    check (pg_column_size(operations_snapshot) <= 262144),
  response jsonb
    check (response is null or pg_column_size(response) <= 262144),
  model_name text,
  error_code text,
  error_detail text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supervisor_requests_prompt_length check (length(btrim(prompt)) between 1 and 2000),
  constraint supervisor_requests_error_length check (error_detail is null or length(error_detail) <= 2000),
  constraint supervisor_requests_worker_length check (worker_id is null or length(worker_id) <= 160)
);

create index if not exists supervisor_requests_queue_idx
  on public.supervisor_requests(status, priority desc, queued_at)
  where status in ('queued','processing');

create index if not exists supervisor_requests_requested_by_idx
  on public.supervisor_requests(requested_by, created_at desc);

alter table public.supervisor_requests enable row level security;

drop policy if exists "operations staff view supervisor requests" on public.supervisor_requests;
create policy "operations staff view supervisor requests"
on public.supervisor_requests
for select
to authenticated
using (
  (select public.current_staff_role()) = any (array['owner'::text,'admin'::text,'dispatcher'::text])
);

revoke all on public.supervisor_requests from public, anon, authenticated;
grant select on public.supervisor_requests to authenticated;
grant select, insert, update on public.supervisor_requests to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'supervisor_requests'
  ) then
    alter publication supabase_realtime add table public.supervisor_requests;
  end if;
end;
$$;

create or replace function public.create_supervisor_request_v1(
  p_prompt text,
  p_priority integer default 0
)
returns public.supervisor_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_request public.supervisor_requests%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  v_role := public.current_staff_role();
  if v_role is null or v_role not in ('owner','admin','dispatcher') then
    raise exception 'operations staff access required' using errcode = '42501';
  end if;
  if p_prompt is null or length(btrim(p_prompt)) not between 1 and 2000 then
    raise exception 'supervisor prompt must contain 1 to 2000 characters' using errcode = '22023';
  end if;
  if p_priority not between 0 and 3 then
    raise exception 'invalid supervisor priority' using errcode = '22023';
  end if;

  insert into public.supervisor_requests(requested_by,prompt,priority)
  values (auth.uid(),btrim(p_prompt),p_priority)
  returning * into v_request;
  return v_request;
end;
$$;

create or replace function public.claim_supervisor_request_v1(
  p_worker_id text,
  p_lease_minutes integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.supervisor_requests%rowtype;
  v_claim_token uuid := gen_random_uuid();
begin
  perform private.assert_messaging_service_role();
  if p_worker_id is null or length(btrim(p_worker_id)) not between 1 and 160 then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  if p_lease_minutes not between 1 and 60 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;

  select * into v_request
  from public.supervisor_requests r
  where r.status = 'queued'
     or (
       r.status = 'processing'
       and r.started_at < now() - make_interval(mins => p_lease_minutes)
       and r.attempt_count < 5
     )
  order by r.priority desc,r.queued_at
  for update skip locked
  limit 1;

  if not found then return null; end if;

  update public.supervisor_requests
  set status = 'processing',
      claim_token = v_claim_token,
      worker_id = btrim(p_worker_id),
      attempt_count = attempt_count + 1,
      started_at = now(),
      completed_at = null,
      error_code = null,
      error_detail = null,
      updated_at = now()
  where id = v_request.id
  returning * into v_request;

  return jsonb_build_object(
    'id',v_request.id,
    'prompt',v_request.prompt,
    'priority',v_request.priority,
    'claim_token',v_request.claim_token,
    'attempt_count',v_request.attempt_count,
    'queued_at',v_request.queued_at
  );
end;
$$;

create or replace function public.get_supervisor_operations_snapshot_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_health jsonb;
begin
  perform private.assert_messaging_service_role();
  select to_jsonb(h) into v_health from public.get_getit_operator_health() h;

  return jsonb_build_object(
    'captured_at',now(),
    'cash_only',true,
    'prelaunch',jsonb_build_object(
      'public_launch_area',jsonb_build_array('Villiers','Qalabotjha'),
      'normal_order_area','Villiers',
      'launch_date','2026-10-01'
    ),
    'health',coalesce(v_health,'{}'::jsonb),
    'counts',jsonb_build_object(
      'orders_by_status',(
        select coalesce(jsonb_object_agg(s.status,s.total),'{}'::jsonb)
        from (select status,count(*)::integer total from public.orders group by status) s
      ),
      'payments_by_status',(
        select coalesce(jsonb_object_agg(s.status,s.total),'{}'::jsonb)
        from (select status,count(*)::integer total from public.payment_reviews group by status) s
      ),
      'open_support_queries',(select count(*)::integer from public.support_queries where status='open'),
      'open_messaging_incidents',(select count(*)::integer from public.messaging_incidents where status in ('open','investigating')),
      'staff_owned_conversations',(select count(*)::integer from public.messaging_conversations where status<>'closed' and mode in ('human','paused')),
      'applications_waiting',(select count(*)::integer from public.partner_applications where status in ('submitted','reviewing')),
      'active_waitlist',(select count(*)::integer from public.customer_waitlist where entry_status='active'),
      'active_shops',(select count(*)::integer from public.shops where active),
      'active_drivers',(select count(*)::integer from public.drivers where active),
      'catalogues_waiting_review',(select count(*)::integer from public.partner_catalogue_submissions where status in ('uploaded','extracting','extracted','reviewing')),
      'automation_backlog',(select count(*)::integer from public.automation_events where status in ('pending','failed','processing'))
    ),
    'attention',jsonb_build_object(
      'support_queries',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'id',q.id,'order_id',q.order_id,'issue_type',q.issue_type,
          'summary',left(q.issue_summary,500),'created_at',q.created_at
        ) order by q.created_at),'[]'::jsonb)
        from (select * from public.support_queries where status='open' order by created_at limit 20) q
      ),
      'messaging_incidents',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'id',i.id,'conversation_id',i.conversation_id,'severity',i.severity,
          'category',i.category,'summary',left(i.summary,500),'status',i.status,'created_at',i.created_at
        ) order by i.created_at),'[]'::jsonb)
        from (select * from public.messaging_incidents where status in ('open','investigating') order by created_at limit 20) i
      ),
      'applications',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'id',a.id,'type',a.application_type,'display_name',coalesce(a.business_name,a.applicant_name,'Applicant'),
          'status',a.status,'submitted_at',a.submitted_at,'current_step',a.current_step
        ) order by a.submitted_at nulls last),'[]'::jsonb)
        from (select * from public.partner_applications where status in ('submitted','reviewing') order by submitted_at nulls last limit 20) a
      ),
      'automation_events',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'id',e.id,'event_type',e.event_type,'status',e.status,'attempts',e.attempts,
          'error',left(e.error_message,500),'created_at',e.created_at,'updated_at',e.updated_at
        ) order by e.created_at),'[]'::jsonb)
        from (select * from public.automation_events where status in ('pending','failed','processing') order by created_at limit 20) e
      )
    ),
    'capabilities',jsonb_build_object(
      'mode','read_only_advisor',
      'can_send_customer_messages',false,
      'can_approve_payments',false,
      'can_activate_partners',false,
      'can_execute_database_commands',false,
      'requires_staff_confirmation_for_actions',true
    )
  );
end;
$$;

create or replace function public.finish_supervisor_request_v1(
  p_request_id uuid,
  p_claim_token uuid,
  p_success boolean,
  p_snapshot jsonb default '{}'::jsonb,
  p_response jsonb default null,
  p_model_name text default null,
  p_error_code text default null,
  p_error_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.supervisor_requests%rowtype;
begin
  perform private.assert_messaging_service_role();
  if p_request_id is null or p_claim_token is null then
    raise exception 'request id and claim token are required' using errcode='22023';
  end if;
  if pg_column_size(coalesce(p_snapshot,'{}'::jsonb)) > 262144
     or (p_response is not null and pg_column_size(p_response) > 262144) then
    raise exception 'supervisor payload too large' using errcode='22023';
  end if;

  select * into v_request
  from public.supervisor_requests r
  where r.id=p_request_id and r.claim_token=p_claim_token and r.status='processing'
  for update;
  if not found then raise exception 'supervisor claim is stale or missing' using errcode='P0002'; end if;

  update public.supervisor_requests
  set status=case when p_success then 'completed' else 'failed' end,
      operations_snapshot=coalesce(p_snapshot,'{}'::jsonb),
      response=case when p_success then p_response else null end,
      model_name=nullif(btrim(p_model_name),''),
      error_code=case when p_success then null else coalesce(nullif(btrim(p_error_code),''),'SUPERVISOR_FAILED') end,
      error_detail=case when p_success then null else left(coalesce(nullif(btrim(p_error_detail),''),'Supervisor could not produce a safe response.'),2000) end,
      completed_at=now(),updated_at=now()
  where id=v_request.id
  returning * into v_request;

  return jsonb_build_object('id',v_request.id,'status',v_request.status,'completed_at',v_request.completed_at);
end;
$$;

create or replace function public.staff_add_customer_to_waitlist_v1(
  p_conversation_id uuid,
  p_source_message_id bigint default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_actor uuid := auth.uid();
  v_conversation public.messaging_conversations%rowtype;
  v_customer public.customers%rowtype;
  v_message public.messaging_messages%rowtype;
  v_waitlist public.customer_waitlist%rowtype;
  v_normalized_phone text;
  v_contact_key text;
  v_town text;
  v_request_id bigint;
  v_already_active boolean := false;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  v_role:=public.current_staff_role();
  if v_role is null or v_role not in ('owner','admin','dispatcher') then
    raise exception 'operations staff access required' using errcode='42501';
  end if;
  if p_note is not null and length(p_note)>1000 then raise exception 'note too long' using errcode='22023'; end if;

  select * into v_conversation from public.messaging_conversations c where c.id=p_conversation_id for update;
  if not found then raise exception 'conversation not found' using errcode='P0002'; end if;
  if v_conversation.customer_id is not null then
    select * into v_customer from public.customers c where c.id=v_conversation.customer_id;
  end if;
  if p_source_message_id is not null then
    select * into v_message from public.messaging_messages m
    where m.id=p_source_message_id and m.conversation_id=p_conversation_id and m.direction='inbound';
    if not found then raise exception 'inbound source message not found' using errcode='P0002'; end if;
  end if;

  v_normalized_phone:=private.normalize_messaging_phone(coalesce(v_customer.phone,v_conversation.external_contact_key));
  v_contact_key:=case
    when v_conversation.customer_id is not null then 'customer:'||v_conversation.customer_id::text
    when v_normalized_phone is not null then 'phone:'||v_normalized_phone
    else 'provider:'||lower(v_conversation.provider)||':'||v_conversation.external_contact_key
  end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_contact_key,2300));
  if v_customer.delivery_zone_id is not null then
    select coalesce(nullif(btrim(z.town),''),nullif(btrim(z.name),'')) into v_town
    from public.delivery_zones z where z.id=v_customer.delivery_zone_id;
  end if;
  if v_town is null and coalesce(v_customer.default_address,'') ~* '\\mvilliers\\M' then v_town:='Villiers'; end if;

  select * into v_waitlist from public.customer_waitlist w
  where w.entry_status='active' and (
    w.contact_key=v_contact_key
    or (v_conversation.customer_id is not null and w.customer_id=v_conversation.customer_id)
    or (v_normalized_phone is not null and w.normalized_phone=v_normalized_phone)
  ) order by w.signup_at,w.id limit 1 for update;
  v_already_active:=found;

  if v_already_active then
    update public.customer_waitlist
    set customer_id=coalesce(v_conversation.customer_id,customer_id),conversation_id=v_conversation.id,
        normalized_phone=coalesce(v_normalized_phone,normalized_phone),
        contact_name=coalesce(nullif(btrim(v_customer.full_name),''),contact_name),
        town=coalesce(v_town,town),location_text=coalesce(nullif(btrim(v_customer.default_address),''),location_text),
        last_source_message_id=coalesce(p_source_message_id,last_source_message_id),
        last_requested_at=coalesce(v_message.created_at,now()),
        metadata=metadata || jsonb_build_object('staff_override_at',now(),'staff_override_by',v_actor,'staff_override_note',coalesce(p_note,'')),
        updated_at=now()
    where id=v_waitlist.id returning * into v_waitlist;
  else
    insert into public.customer_waitlist(
      customer_id,conversation_id,contact_key,normalized_phone,contact_name,town,location_text,
      entry_status,source_type,first_source_message_id,last_source_message_id,request_count,
      signup_at,last_requested_at,confirmation_status,metadata
    ) values (
      v_conversation.customer_id,v_conversation.id,v_contact_key,v_normalized_phone,nullif(btrim(v_customer.full_name),''),
      v_town,nullif(btrim(v_customer.default_address),''),'active','staff',p_source_message_id,p_source_message_id,1,
      coalesce(v_message.created_at,now()),coalesce(v_message.created_at,now()),'suppressed',
      jsonb_build_object('staff_override_at',now(),'staff_override_by',v_actor,'staff_override_note',coalesce(p_note,''))
    ) returning * into v_waitlist;
  end if;

  v_result:=jsonb_build_object(
    'handled',true,'classification','enroll','reason_code',case when v_already_active then 'WAITLIST_ALREADY_ACTIVE' else 'WAITLIST_ADDED_BY_STAFF' end,
    'waitlist_id',v_waitlist.id,'status',v_waitlist.entry_status,'already_active',v_already_active,
    'confirmation_status','suppressed','dispatch_allowed',false
  );

  if p_source_message_id is not null then
    select id into v_request_id from private.customer_waitlist_requests where source_message_id=p_source_message_id;
  end if;
  if v_request_id is null then
    insert into private.customer_waitlist_requests(
      waitlist_id,conversation_id,source_message_id,source_submission_id,source_type,classification_reason,
      normalized_body,body_fingerprint,confirmation_body,confirmation_status,suppression_reason,result,requested_at
    ) values (
      v_waitlist.id,v_conversation.id,p_source_message_id,
      case when p_source_message_id is null then 'staff:'||v_waitlist.id::text||':'||extract(epoch from now())::bigint::text else null end,
      'staff','STAFF_CONFIRMED_WAITLIST_INTENT',left(lower(btrim(coalesce(v_message.body,''))),4000),
      case when v_message.body is null then null else encode(extensions.digest(convert_to(v_message.body,'UTF8'),'sha256'),'hex') end,
      'Added by Getit staff. No automatic historical confirmation was sent.','suppressed','STAFF_OVERRIDE_NO_AUTOMATIC_SEND',v_result,
      coalesce(v_message.created_at,now())
    ) returning id into v_request_id;
  end if;

  return v_result || jsonb_build_object('request_id',v_request_id);
end;
$$;

revoke all on function public.create_supervisor_request_v1(text,integer) from public,anon;
grant execute on function public.create_supervisor_request_v1(text,integer) to authenticated,service_role;

revoke all on function public.claim_supervisor_request_v1(text,integer) from public,anon,authenticated;
grant execute on function public.claim_supervisor_request_v1(text,integer) to service_role;

revoke all on function public.get_supervisor_operations_snapshot_v1() from public,anon,authenticated;
grant execute on function public.get_supervisor_operations_snapshot_v1() to service_role;

revoke all on function public.finish_supervisor_request_v1(uuid,uuid,boolean,jsonb,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.finish_supervisor_request_v1(uuid,uuid,boolean,jsonb,jsonb,text,text,text) to service_role;

revoke all on function public.staff_add_customer_to_waitlist_v1(uuid,bigint,text) from public,anon;
grant execute on function public.staff_add_customer_to_waitlist_v1(uuid,bigint,text) to authenticated,service_role;

comment on table public.supervisor_requests is
  'Staff-only, read-only-advisor queue for the local Getit operations supervisor. Model responses never execute actions directly.';
comment on function public.staff_add_customer_to_waitlist_v1(uuid,bigint,text) is
  'Idempotent authenticated staff override for confirmed waitlist intent. It never queues an automatic outbound message.';


