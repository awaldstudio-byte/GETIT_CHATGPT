-- Getit WhatsApp partner applications and first-contact menu v1.16.0
-- Applications are review records only. They never activate a shop or driver.

create table if not exists public.partner_applications (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.messaging_conversations(id) on delete cascade,
  application_type text not null check (application_type in ('shop','driver')),
  status text not null default 'draft' check (status in ('draft','submitted','reviewing','approved','rejected','withdrawn')),
  applicant_phone text,
  applicant_name text,
  business_name text,
  business_type text,
  location_text text,
  location_latitude numeric,
  location_longitude numeric,
  has_own_bike boolean,
  availability text,
  current_step text not null,
  answers jsonb not null default '{}'::jsonb,
  source_message_id bigint references public.messaging_messages(id) on delete set null,
  assigned_staff_user_id uuid references auth.users(id) on delete set null,
  review_note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  submitted_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists partner_applications_one_active_per_type
  on public.partner_applications(conversation_id, application_type)
  where status in ('draft','submitted','reviewing');
create index if not exists partner_applications_queue_idx
  on public.partner_applications(status, submitted_at desc nulls last, created_at desc);
create index if not exists partner_applications_conversation_idx
  on public.partner_applications(conversation_id, updated_at desc);

drop trigger if exists partner_applications_set_updated_at on public.partner_applications;
create trigger partner_applications_set_updated_at
before update on public.partner_applications
for each row execute function public.set_updated_at();

alter table public.partner_applications enable row level security;
revoke all on table public.partner_applications from public, anon, authenticated;
grant select on table public.partner_applications to authenticated;
grant all on table public.partner_applications to service_role;

drop policy if exists "operations staff view partner applications" on public.partner_applications;
create policy "operations staff view partner applications"
on public.partner_applications for select to authenticated
using ((select public.current_staff_role()) in ('owner','admin','dispatcher'));

create table if not exists private.partner_application_message_receipts (
  message_id bigint primary key references public.messaging_messages(id) on delete cascade,
  application_id uuid references public.partner_applications(id) on delete set null,
  result jsonb not null,
  processed_at timestamptz not null default now()
);
revoke all on table private.partner_application_message_receipts from public, anon, authenticated;
grant all on table private.partner_application_message_receipts to service_role;

create or replace function public.process_partner_application_message(
  p_conversation_id uuid,
  p_message_id bigint,
  p_message_type text,
  p_body text,
  p_payload jsonb default '{}'::jsonb,
  p_interactive_reply_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_conversation public.messaging_conversations%rowtype;
  v_application public.partner_applications%rowtype;
  v_existing jsonb;
  v_result jsonb;
  v_body text := left(btrim(coalesce(p_body,'')), 2000);
  v_lower text := lower(left(btrim(coalesce(p_body,'')), 2000));
  v_reply_id text := lower(btrim(coalesce(p_interactive_reply_id,'')));
  v_lat numeric;
  v_lng numeric;
  v_summary text;
begin
  perform private.assert_messaging_service_role();

  select r.result into v_existing
  from private.partner_application_message_receipts r
  where r.message_id = p_message_id;
  if found then return v_existing; end if;

  select * into v_conversation
  from public.messaging_conversations c
  where c.id = p_conversation_id
  for update;
  if not found then raise exception 'conversation not found' using errcode='P0002'; end if;

  if not exists (
    select 1 from public.messaging_messages m
    where m.id=p_message_id and m.conversation_id=p_conversation_id and m.direction='inbound'
  ) then raise exception 'inbound message not found' using errcode='P0002'; end if;

  select * into v_application
  from public.partner_applications a
  where a.conversation_id=p_conversation_id and a.status='draft'
  order by a.created_at desc
  limit 1
  for update;

  if v_reply_id = 'getit_order_groceries' or v_lower in ('order groceries','go shopping') then
    if v_application.id is not null then
      update public.partner_applications set status='withdrawn', current_step='cancelled', version=version+1
      where id=v_application.id;
    end if;
    v_result := jsonb_build_object('handled',true,'reason_code','WELCOME_ORDER_SELECTED','response_body','Great - what would you like Getit to buy for you?','application_id',null,'application_type',null,'status',null);

  elsif v_reply_id = 'getit_register_shop' or v_lower in ('register my shop','register shop','join getit as a shop') then
    if v_application.id is not null then
      update public.partner_applications set status='withdrawn', current_step='replaced', version=version+1 where id=v_application.id;
    end if;
    insert into public.partner_applications(conversation_id,application_type,applicant_phone,current_step,source_message_id)
    values (p_conversation_id,'shop',v_conversation.external_contact_key,'business_name',p_message_id)
    returning * into v_application;
    v_result := jsonb_build_object('handled',true,'reason_code','SHOP_APPLICATION_STARTED','response_body','Great - let''s register your shop. What is the shop''s name? Reply CANCEL at any time.','application_id',v_application.id,'application_type','shop','status','draft');

  elsif v_reply_id = 'getit_become_driver' or v_lower in ('become a driver','apply as a driver','join getit as a driver') then
    if v_application.id is not null then
      update public.partner_applications set status='withdrawn', current_step='replaced', version=version+1 where id=v_application.id;
    end if;
    insert into public.partner_applications(conversation_id,application_type,applicant_phone,current_step,source_message_id)
    values (p_conversation_id,'driver',v_conversation.external_contact_key,'driver_consent',p_message_id)
    returning * into v_application;
    v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_APPLICATION_STARTED','response_body','Before you apply: you need your own working motorbike. Getit is still launching, so applying does not guarantee work. Reply CONTINUE to apply or CANCEL.','application_id',v_application.id,'application_type','driver','status','draft');

  elsif v_application.id is null then
    v_result := jsonb_build_object('handled',false);

  elsif v_lower in ('cancel','stop application','cancel application') then
    update public.partner_applications
    set status='withdrawn',current_step='cancelled',source_message_id=p_message_id,version=version+1
    where id=v_application.id returning * into v_application;
    v_result := jsonb_build_object('handled',true,'reason_code','PARTNER_APPLICATION_CANCELLED','response_body','No problem - the application has been cancelled.','application_id',v_application.id,'application_type',v_application.application_type,'status','withdrawn');

  elsif v_application.application_type='shop' then
    case v_application.current_step
      when 'business_name' then
        if length(v_body) < 2 then
          v_result := jsonb_build_object('handled',true,'reason_code','SHOP_NAME_REQUIRED','response_body','Please type the shop''s full name.','application_id',v_application.id,'application_type','shop','status','draft');
        else
          update public.partner_applications set business_name=left(v_body,200),current_step='business_type',source_message_id=p_message_id,version=version+1 where id=v_application.id returning * into v_application;
          v_result := jsonb_build_object('handled',true,'reason_code','SHOP_TYPE_REQUESTED','response_body','What does the shop sell? For example: groceries, takeaway food, clothing or hardware.','application_id',v_application.id,'application_type','shop','status','draft');
        end if;
      when 'business_type' then
        if length(v_body) < 2 then
          v_result := jsonb_build_object('handled',true,'reason_code','SHOP_TYPE_REQUIRED','response_body','Please tell me what the shop sells.','application_id',v_application.id,'application_type','shop','status','draft');
        else
          update public.partner_applications set business_type=left(v_body,300),current_step='location',source_message_id=p_message_id,version=version+1 where id=v_application.id returning * into v_application;
          v_result := jsonb_build_object('handled',true,'reason_code','SHOP_LOCATION_REQUESTED','response_body','Please send the shop''s WhatsApp location pin, or type its full Villiers address.','application_id',v_application.id,'application_type','shop','status','draft');
        end if;
      when 'location' then
        begin
          v_lat := nullif(p_payload #>> '{message,location,latitude}','')::numeric;
          v_lng := nullif(p_payload #>> '{message,location,longitude}','')::numeric;
        exception when others then v_lat:=null; v_lng:=null; end;
        if p_message_type <> 'location' and length(v_body) < 5 then
          v_result := jsonb_build_object('handled',true,'reason_code','SHOP_LOCATION_REQUIRED','response_body','Please send a location pin or type the full shop address.','application_id',v_application.id,'application_type','shop','status','draft');
        else
          update public.partner_applications
          set location_text=case when p_message_type='location' then coalesce(nullif(p_payload #>> '{message,location,address}',''),'WhatsApp location pin') else left(v_body,500) end,
              location_latitude=v_lat,location_longitude=v_lng,current_step='applicant_name',source_message_id=p_message_id,version=version+1
          where id=v_application.id returning * into v_application;
          v_result := jsonb_build_object('handled',true,'reason_code','SHOP_CONTACT_NAME_REQUESTED','response_body','What is your full name?','application_id',v_application.id,'application_type','shop','status','draft');
        end if;
      when 'applicant_name' then
        if length(v_body) < 2 then
          v_result := jsonb_build_object('handled',true,'reason_code','APPLICANT_NAME_REQUIRED','response_body','Please type your full name.','application_id',v_application.id,'application_type','shop','status','draft');
        else
          update public.partner_applications set applicant_name=left(v_body,200),current_step='confirm',source_message_id=p_message_id,version=version+1 where id=v_application.id returning * into v_application;
          v_summary := 'Please confirm your shop application:'||E'\n'||'Shop: '||v_application.business_name||E'\n'||'Sells: '||v_application.business_type||E'\n'||'Location: '||v_application.location_text||E'\n'||'Contact: '||v_application.applicant_name||E'\n\n'||'Reply YES to send it to Getit, or CANCEL.';
          v_result := jsonb_build_object('handled',true,'reason_code','SHOP_APPLICATION_CONFIRMATION','response_body',v_summary,'application_id',v_application.id,'application_type','shop','status','draft');
        end if;
      when 'confirm' then
        if v_lower in ('yes','yes please','confirm','confirmed','ja','submit') then
          update public.partner_applications set status='submitted',current_step='completed',submitted_at=now(),source_message_id=p_message_id,version=version+1 where id=v_application.id returning * into v_application;
          v_result := jsonb_build_object('handled',true,'reason_code','SHOP_APPLICATION_SUBMITTED','response_body','Thank you - your shop application has been sent to the Getit team for review. This does not make the shop live yet.','application_id',v_application.id,'application_type','shop','status','submitted');
        else
          v_result := jsonb_build_object('handled',true,'reason_code','SHOP_APPLICATION_AWAITING_CONFIRMATION','response_body','Reply YES to submit the application, or CANCEL to stop.','application_id',v_application.id,'application_type','shop','status','draft');
        end if;
      else
        v_result := jsonb_build_object('handled',true,'reason_code','PARTNER_APPLICATION_STATE_INVALID','response_body',null,'application_id',v_application.id,'application_type','shop','status','draft','requires_human',true);
    end case;

  else
    case v_application.current_step
      when 'driver_consent' then
        if v_lower in ('continue','yes','yes please','ja','apply') then
          update public.partner_applications set current_step='applicant_name',source_message_id=p_message_id,version=version+1 where id=v_application.id returning * into v_application;
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_NAME_REQUESTED','response_body','What is your full name?','application_id',v_application.id,'application_type','driver','status','draft');
        else
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_CONSENT_REQUIRED','response_body','Reply CONTINUE if you understand that you need your own motorbike and that work is not guaranteed, or CANCEL.','application_id',v_application.id,'application_type','driver','status','draft');
        end if;
      when 'applicant_name' then
        if length(v_body) < 2 then
          v_result := jsonb_build_object('handled',true,'reason_code','APPLICANT_NAME_REQUIRED','response_body','Please type your full name.','application_id',v_application.id,'application_type','driver','status','draft');
        else
          update public.partner_applications set applicant_name=left(v_body,200),current_step='location',source_message_id=p_message_id,version=version+1 where id=v_application.id returning * into v_application;
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_LOCATION_REQUESTED','response_body','Which part of Villiers are you based in? You can type the area or send a WhatsApp location pin.','application_id',v_application.id,'application_type','driver','status','draft');
        end if;
      when 'location' then
        begin
          v_lat := nullif(p_payload #>> '{message,location,latitude}','')::numeric;
          v_lng := nullif(p_payload #>> '{message,location,longitude}','')::numeric;
        exception when others then v_lat:=null; v_lng:=null; end;
        if p_message_type <> 'location' and length(v_body) < 2 then
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_LOCATION_REQUIRED','response_body','Please type your Villiers area or send a location pin.','application_id',v_application.id,'application_type','driver','status','draft');
        else
          update public.partner_applications
          set location_text=case when p_message_type='location' then coalesce(nullif(p_payload #>> '{message,location,address}',''),'WhatsApp location pin') else left(v_body,500) end,
              location_latitude=v_lat,location_longitude=v_lng,current_step='own_bike',source_message_id=p_message_id,version=version+1
          where id=v_application.id returning * into v_application;
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_BIKE_CONFIRMATION','response_body','Do you have your own working motorbike that you can use for deliveries? Reply YES or NO.','application_id',v_application.id,'application_type','driver','status','draft');
        end if;
      when 'own_bike' then
        if v_lower in ('yes','yes i do','yes please','ja') then
          update public.partner_applications set has_own_bike=true,current_step='availability',source_message_id=p_message_id,version=version+1 where id=v_application.id returning * into v_application;
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_AVAILABILITY_REQUESTED','response_body','When are you usually available to deliver? For example: weekdays, evenings or weekends.','application_id',v_application.id,'application_type','driver','status','draft');
        elsif v_lower in ('no','no i do not','nope','nee') then
          update public.partner_applications set has_own_bike=false,status='withdrawn',current_step='not_eligible',source_message_id=p_message_id,version=version+1 where id=v_application.id returning * into v_application;
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_OWN_BIKE_REQUIRED','response_body','Thanks for your interest. Getit drivers need their own working motorbike, so we cannot continue this application right now.','application_id',v_application.id,'application_type','driver','status','withdrawn');
        else
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_BIKE_ANSWER_REQUIRED','response_body','Please reply YES or NO. Getit drivers need their own working motorbike.','application_id',v_application.id,'application_type','driver','status','draft');
        end if;
      when 'availability' then
        if length(v_body) < 2 then
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_AVAILABILITY_REQUIRED','response_body','Please tell me when you are usually available.','application_id',v_application.id,'application_type','driver','status','draft');
        else
          update public.partner_applications set availability=left(v_body,500),current_step='confirm',source_message_id=p_message_id,version=version+1 where id=v_application.id returning * into v_application;
          v_summary := 'Please confirm your driver application:'||E'\n'||'Name: '||v_application.applicant_name||E'\n'||'Area: '||v_application.location_text||E'\n'||'Own working motorbike: Yes'||E'\n'||'Availability: '||v_application.availability||E'\n\n'||'Applying does not guarantee work while Getit is launching. Reply YES to submit, or CANCEL.';
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_APPLICATION_CONFIRMATION','response_body',v_summary,'application_id',v_application.id,'application_type','driver','status','draft');
        end if;
      when 'confirm' then
        if v_lower in ('yes','yes please','confirm','confirmed','ja','submit') then
          update public.partner_applications set status='submitted',current_step='completed',submitted_at=now(),source_message_id=p_message_id,version=version+1 where id=v_application.id returning * into v_application;
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_APPLICATION_SUBMITTED','response_body','Thank you - your driver application has been sent to the Getit team for review. Getit is still launching, so this is not a promise of work.','application_id',v_application.id,'application_type','driver','status','submitted');
        else
          v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_APPLICATION_AWAITING_CONFIRMATION','response_body','Reply YES to submit the application, or CANCEL to stop.','application_id',v_application.id,'application_type','driver','status','draft');
        end if;
      else
        v_result := jsonb_build_object('handled',true,'reason_code','PARTNER_APPLICATION_STATE_INVALID','response_body',null,'application_id',v_application.id,'application_type','driver','status','draft','requires_human',true);
    end case;
  end if;

  insert into private.partner_application_message_receipts(message_id,application_id,result)
  values (p_message_id, nullif(v_result->>'application_id','')::uuid, v_result)
  on conflict (message_id) do nothing;
  return v_result;
end;
$function$;

create or replace function public.get_partner_application_queue(p_limit integer default 200)
returns table(
  id uuid, conversation_id uuid, application_type text, status text,
  applicant_phone text, applicant_name text, business_name text, business_type text,
  location_text text, location_latitude numeric, location_longitude numeric,
  has_own_bike boolean, availability text, current_step text, answers jsonb,
  review_note text, submitted_at timestamptz, reviewed_at timestamptz,
  version bigint, created_at timestamptz, updated_at timestamptz
)
language plpgsql security definer set search_path=''
as $function$
begin
  if public.current_staff_role() not in ('owner','admin','dispatcher') then
    raise exception 'staff access required' using errcode='42501';
  end if;
  if p_limit not between 1 and 500 then raise exception 'invalid limit' using errcode='22023'; end if;
  return query
  select a.id,a.conversation_id,a.application_type,a.status,a.applicant_phone,a.applicant_name,
         a.business_name,a.business_type,a.location_text,a.location_latitude,a.location_longitude,
         a.has_own_bike,a.availability,a.current_step,a.answers,a.review_note,a.submitted_at,a.reviewed_at,
         a.version,a.created_at,a.updated_at
  from public.partner_applications a
  where a.status in ('submitted','reviewing','approved','rejected')
  order by case a.status when 'submitted' then 0 when 'reviewing' then 1 when 'approved' then 2 else 3 end,
           coalesce(a.submitted_at,a.created_at) desc
  limit p_limit;
end;
$function$;

create or replace function public.review_partner_application_v1(
  p_application_id uuid,
  p_status text,
  p_review_note text,
  p_expected_version bigint
)
returns public.partner_applications
language plpgsql security definer set search_path=''
as $function$
declare v_application public.partner_applications%rowtype;
begin
  if public.current_staff_role() not in ('owner','admin','dispatcher') then
    raise exception 'staff access required' using errcode='42501';
  end if;
  if p_status not in ('reviewing','approved','rejected') then raise exception 'invalid review status' using errcode='22023'; end if;
  if p_review_note is not null and length(p_review_note)>2000 then raise exception 'review note too long' using errcode='22023'; end if;
  update public.partner_applications a
  set status=p_status,review_note=nullif(btrim(coalesce(p_review_note,'')),''),reviewed_by=auth.uid(),reviewed_at=now(),version=a.version+1
  where a.id=p_application_id and a.version=p_expected_version and a.status in ('submitted','reviewing','approved','rejected')
  returning * into v_application;
  if not found then raise exception 'application changed; refresh and try again' using errcode='40001'; end if;
  return v_application;
end;
$function$;

create or replace function public.queue_decision_response_v2(
  p_event_id bigint,
  p_idempotency_key text,
  p_body text,
  p_payload jsonb default '{}'::jsonb,
  p_offer_welcome_menu boolean default true,
  p_max_attempts integer default 5
)
returns table(message_id bigint,outbox_id bigint,queue_status text)
language plpgsql security definer set search_path=''
as $function$
declare
  v_event private.messaging_inbox_events%rowtype;
  v_decision private.messaging_decisions%rowtype;
  v_conversation public.messaging_conversations%rowtype;
  v_message public.messaging_messages%rowtype;
  v_prior_inbound_at timestamptz;
  v_offer boolean := false;
  v_payload jsonb;
begin
  perform private.assert_messaging_service_role();
  if p_body is null or btrim(p_body)='' or length(p_body)>12000 then raise exception 'response body must be 1 to 12000 characters' using errcode='22023'; end if;
  if pg_column_size(coalesce(p_payload,'{}'::jsonb))>262144 then raise exception 'response payload exceeds 256 KiB' using errcode='22023'; end if;
  select * into v_event from private.messaging_inbox_events where id=p_event_id;
  if not found then raise exception 'inbox event not found' using errcode='P0002'; end if;
  select * into v_decision from private.messaging_decisions where inbox_event_id=p_event_id and is_final order by decision_version desc limit 1;
  if not found then raise exception 'final response decision not found' using errcode='P0002'; end if;
  if v_decision.decision not in ('respond_now','light_ack') or not v_decision.schema_valid or not v_decision.facts_valid then
    return query select null::bigint,null::bigint,'suppressed'::text; return;
  end if;
  if v_event.conversation_id is null or v_event.message_id is null then raise exception 'event has not been attached to a conversation and message' using errcode='22023'; end if;
  select * into v_conversation from public.messaging_conversations where id=v_event.conversation_id;
  select * into v_message from public.messaging_messages where id=v_event.message_id;
  if v_conversation.id is null or v_message.id is null then raise exception 'conversation or inbound message not found' using errcode='P0002'; end if;

  if p_offer_welcome_menu then
    select max(m.created_at) into v_prior_inbound_at
    from public.messaging_messages m
    where m.conversation_id=v_event.conversation_id and m.direction='inbound' and m.id<>v_event.message_id and (m.created_at<v_message.created_at or (m.created_at=v_message.created_at and m.id<v_message.id));
    v_offer := v_prior_inbound_at is null or v_prior_inbound_at <= v_message.created_at - interval '24 hours';
  end if;

  v_payload := coalesce(p_payload,'{}'::jsonb) || jsonb_build_object(
    'response_decision',v_decision.decision,'decision_reason',v_decision.reason_code,'prompt_version',v_decision.prompt_version
  );
  if v_offer then
    v_payload := v_payload || jsonb_build_object('interactive_menu','getit_first_contact_v1');
  end if;
  return query select * from public.queue_outbound_message(
    v_event.conversation_id,p_idempotency_key,v_conversation.external_contact_key,v_conversation.provider,
    case when v_offer then 'interactive_menu' else 'text' end,btrim(p_body),v_payload,v_event.message_id,p_max_attempts
  );
end;
$function$;

revoke all on function public.process_partner_application_message(uuid,bigint,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.process_partner_application_message(uuid,bigint,text,text,jsonb,text) to service_role;
revoke all on function public.get_partner_application_queue(integer) from public,anon;
grant execute on function public.get_partner_application_queue(integer) to authenticated,service_role;
revoke all on function public.review_partner_application_v1(uuid,text,text,bigint) from public,anon;
grant execute on function public.review_partner_application_v1(uuid,text,text,bigint) to authenticated,service_role;
revoke all on function public.queue_decision_response_v2(bigint,text,text,jsonb,boolean,integer) from public,anon,authenticated;
grant execute on function public.queue_decision_response_v2(bigint,text,text,jsonb,boolean,integer) to service_role;

comment on table public.partner_applications is 'WhatsApp shop and driver applications awaiting staff review. Approval never activates an operational shop or driver.';
comment on function public.process_partner_application_message(uuid,bigint,text,text,jsonb,text) is 'Idempotent deterministic WhatsApp application state machine; service role only.';
comment on function public.queue_decision_response_v2(bigint,text,text,jsonb,boolean,integer) is 'Queues a normal response or the allowlisted three-button first-contact menu at the start of a new 24-hour inbound window.';

do $block$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='partner_applications'
  ) then
    alter publication supabase_realtime add table public.partner_applications;
  end if;
end;
$block$;
