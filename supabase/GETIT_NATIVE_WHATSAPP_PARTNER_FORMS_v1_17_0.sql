-- Getit native WhatsApp partner forms v1.17.0
-- Replaces the error-prone field-by-field chat questionnaire with validated
-- WhatsApp Flow submissions. Supabase remains the authoritative application ledger.

insert into public.app_settings(key,value,description)
values
  ('whatsapp_shop_application_flow_id', to_jsonb('1756566568719813'::text), 'Published Meta WhatsApp Flow ID for Getit shop applications.'),
  ('whatsapp_driver_application_flow_id', to_jsonb('2604256086674509'::text), 'Published Meta WhatsApp Flow ID for Getit driver applications.'),
  ('whatsapp_partner_application_flow_version', to_jsonb('native_flow_v1'::text), 'Canonical Getit partner application intake version.')
on conflict (key) do update
set value=excluded.value,description=excluded.description,updated_at=now();

update public.partner_applications
set status='withdrawn',current_step='migrated_to_native_whatsapp_form',version=version+1
where status='draft';

create or replace function public.process_partner_application_message_v4(
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
set search_path=''
as $function$
declare
  v_conversation public.messaging_conversations%rowtype;
  v_application public.partner_applications%rowtype;
  v_existing jsonb;
  v_result jsonb;
  v_body text := left(btrim(coalesce(p_body,'')),2000);
  v_lower text := lower(left(btrim(coalesce(p_body,'')),2000));
  v_reply_id text := lower(btrim(coalesce(p_interactive_reply_id,'')));
  v_interactive_type text := lower(coalesce(p_payload #>> '{message,interactive,type}',''));
  v_response_json text := p_payload #>> '{message,interactive,nfm_reply,response_json}';
  v_flow_data jsonb;
  v_application_type text;
  v_flow_token text;
  v_expected_token text;
  v_applicant_name text;
  v_business_name text;
  v_business_type text;
  v_location_text text;
  v_availability text;
  v_has_own_bike boolean;
  v_launch_ack boolean;
begin
  perform private.assert_messaging_service_role();

  select r.result into v_existing
  from private.partner_application_message_receipts r
  where r.message_id=p_message_id;
  if found then return v_existing; end if;

  select * into v_conversation
  from public.messaging_conversations c
  where c.id=p_conversation_id
  for update;
  if not found then raise exception 'conversation not found' using errcode='P0002'; end if;

  if not exists (
    select 1 from public.messaging_messages m
    where m.id=p_message_id and m.conversation_id=p_conversation_id and m.direction='inbound'
  ) then raise exception 'inbound message not found' using errcode='P0002'; end if;

  if v_reply_id='getit_order_groceries' or v_lower in ('order groceries','go shopping') then
    v_result := jsonb_build_object(
      'handled',true,'reason_code','WELCOME_ORDER_SELECTED',
      'response_body','Great - what would you like Getit to buy for you?',
      'application_id',null,'application_type',null,'status',null
    );

  elsif v_reply_id='getit_register_shop' or v_lower in ('register my shop','register shop','join getit as a shop') then
    v_result := jsonb_build_object(
      'handled',true,'reason_code','SHOP_APPLICATION_FORM_OFFERED',
      'response_body','Complete the short Getit shop form below. It will go straight to our Shop Manager for review.',
      'flow_kind','shop','application_id',null,'application_type','shop','status',null
    );

  elsif v_reply_id='getit_become_driver' or v_lower in ('become a driver','apply as a driver','join getit as a driver') then
    v_result := jsonb_build_object(
      'handled',true,'reason_code','DRIVER_APPLICATION_FORM_OFFERED',
      'response_body','Complete the short Getit driver form below. You need your own working motorbike, and applying does not guarantee work while Getit is launching.',
      'flow_kind','driver','application_id',null,'application_type','driver','status',null
    );

  elsif p_message_type='interactive' and v_interactive_type='nfm_reply' then
    begin
      v_flow_data := v_response_json::jsonb;
    exception when others then
      v_flow_data := null;
    end;
    if v_flow_data is null or jsonb_typeof(v_flow_data)<>'object' then
      v_result := jsonb_build_object('handled',true,'reason_code','PARTNER_FORM_INVALID','response_body',null,'requires_human',true);
    else
      v_application_type := lower(btrim(coalesce(v_flow_data->>'application_type','')));
      v_flow_token := btrim(coalesce(v_flow_data->>'flow_token',''));
      v_expected_token := 'getit:'||v_application_type||':'||p_conversation_id::text;
      if v_application_type not in ('shop','driver') or v_flow_token<>v_expected_token then
        v_result := jsonb_build_object('handled',true,'reason_code','PARTNER_FORM_TOKEN_INVALID','response_body',null,'requires_human',true);
      else
        select * into v_application
        from public.partner_applications a
        where a.conversation_id=p_conversation_id
          and a.application_type=v_application_type
          and a.status in ('submitted','reviewing')
        order by a.created_at desc
        limit 1
        for update;

        if v_application.id is not null then
          v_result := jsonb_build_object(
            'handled',true,'reason_code','PARTNER_APPLICATION_ALREADY_RECEIVED',
            'response_body','We already have this application. The Getit team will review it and contact you if anything else is needed.',
            'application_id',v_application.id,'application_type',v_application_type,'status',v_application.status
          );
        elsif v_application_type='shop' then
          v_applicant_name := left(btrim(coalesce(v_flow_data->>'applicant_name','')),200);
          v_business_name := left(btrim(coalesce(v_flow_data->>'business_name','')),200);
          v_business_type := left(btrim(coalesce(v_flow_data->>'business_type','')),300);
          v_location_text := left(btrim(coalesce(v_flow_data->>'location_text','')),500);
          if length(v_applicant_name)<2 or length(v_business_name)<2 or length(v_business_type)<2 or length(v_location_text)<5 then
            v_result := jsonb_build_object('handled',true,'reason_code','SHOP_FORM_VALIDATION_FAILED','response_body',null,'requires_human',true);
          else
            insert into public.partner_applications(
              conversation_id,application_type,status,applicant_phone,applicant_name,business_name,business_type,
              location_text,current_step,answers,source_message_id,submitted_at
            ) values (
              p_conversation_id,'shop','submitted',v_conversation.external_contact_key,v_applicant_name,v_business_name,v_business_type,
              v_location_text,'completed',v_flow_data - 'flow_token',p_message_id,now()
            ) returning * into v_application;
            v_result := jsonb_build_object(
              'handled',true,'reason_code','SHOP_APPLICATION_SUBMITTED',
              'response_body','Thank you - your shop application has been sent to the Getit team for review. This does not make the shop live yet.',
              'application_id',v_application.id,'application_type','shop','status','submitted'
            );
          end if;
        else
          v_applicant_name := left(btrim(coalesce(v_flow_data->>'applicant_name','')),200);
          v_location_text := left(btrim(coalesce(v_flow_data->>'location_text','')),500);
          v_availability := left(btrim(coalesce(v_flow_data->>'availability','')),500);
          v_has_own_bike := lower(coalesce(v_flow_data->>'has_own_bike','')) in ('true','1','yes','on');
          v_launch_ack := lower(coalesce(v_flow_data->>'launch_ack','')) in ('true','1','yes','on');
          if length(v_applicant_name)<2 or length(v_location_text)<2 or length(v_availability)<2 then
            v_result := jsonb_build_object('handled',true,'reason_code','DRIVER_FORM_VALIDATION_FAILED','response_body',null,'requires_human',true);
          elsif not v_has_own_bike or not v_launch_ack then
            v_result := jsonb_build_object(
              'handled',true,'reason_code','DRIVER_FORM_NOT_ELIGIBLE',
              'response_body','Getit drivers need their own working motorbike. Getit is still launching, and an application cannot guarantee work.'
            );
          else
            insert into public.partner_applications(
              conversation_id,application_type,status,applicant_phone,applicant_name,location_text,has_own_bike,
              availability,current_step,answers,source_message_id,submitted_at
            ) values (
              p_conversation_id,'driver','submitted',v_conversation.external_contact_key,v_applicant_name,v_location_text,true,
              v_availability,'completed',v_flow_data - 'flow_token',p_message_id,now()
            ) returning * into v_application;
            v_result := jsonb_build_object(
              'handled',true,'reason_code','DRIVER_APPLICATION_SUBMITTED',
              'response_body','Thank you - your driver application has been sent to the Getit team for review. Getit is still launching, so this is not a promise of work.',
              'application_id',v_application.id,'application_type','driver','status','submitted'
            );
          end if;
        end if;
      end if;
    end if;
  else
    v_result := jsonb_build_object('handled',false);
  end if;

  insert into private.partner_application_message_receipts(message_id,application_id,result)
  values (p_message_id,nullif(v_result->>'application_id','')::uuid,v_result)
  on conflict (message_id) do nothing;
  return v_result;
end;
$function$;

create or replace function public.queue_decision_response_v3(
  p_event_id bigint,
  p_idempotency_key text,
  p_body text,
  p_payload jsonb default '{}'::jsonb,
  p_offer_welcome_menu boolean default true,
  p_max_attempts integer default 5
)
returns table(message_id bigint,outbox_id bigint,queue_status text)
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_event private.messaging_inbox_events%rowtype;
  v_decision private.messaging_decisions%rowtype;
  v_conversation public.messaging_conversations%rowtype;
  v_message public.messaging_messages%rowtype;
  v_prior_inbound_at timestamptz;
  v_offer boolean := false;
  v_payload jsonb;
  v_message_type text := 'text';
  v_flow_kind text := lower(btrim(coalesce(p_payload->>'flow_kind','')));
  v_flow_id text;
begin
  perform private.assert_messaging_service_role();
  if p_body is null or btrim(p_body)='' or length(p_body)>12000 then raise exception 'response body must be 1 to 12000 characters' using errcode='22023'; end if;
  if pg_column_size(coalesce(p_payload,'{}'::jsonb))>262144 then raise exception 'response payload exceeds 256 KiB' using errcode='22023'; end if;
  if v_flow_kind not in ('','shop','driver') then raise exception 'invalid partner flow kind' using errcode='22023'; end if;

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

  if v_flow_kind<>'' then
    select s.value #>> '{}' into v_flow_id
    from public.app_settings s
    where s.key=case v_flow_kind when 'shop' then 'whatsapp_shop_application_flow_id' else 'whatsapp_driver_application_flow_id' end;
    if v_flow_id is null or v_flow_id !~ '^[0-9]+$' then raise exception 'partner flow is not configured' using errcode='55000'; end if;
    v_message_type := 'interactive_flow';
  elsif p_offer_welcome_menu then
    select max(m.created_at) into v_prior_inbound_at
    from public.messaging_messages m
    where m.conversation_id=v_event.conversation_id and m.direction='inbound' and m.id<>v_event.message_id
      and (m.created_at<v_message.created_at or (m.created_at=v_message.created_at and m.id<v_message.id));
    v_offer := v_prior_inbound_at is null or v_prior_inbound_at<=v_message.created_at-interval '24 hours';
    if v_offer then v_message_type := 'interactive_menu'; end if;
  end if;

  v_payload := coalesce(p_payload,'{}'::jsonb) || jsonb_build_object(
    'response_decision',v_decision.decision,'decision_reason',v_decision.reason_code,'prompt_version',v_decision.prompt_version
  );
  if v_offer then v_payload := v_payload || jsonb_build_object('interactive_menu','getit_first_contact_v1'); end if;
  if v_flow_kind<>'' then
    v_payload := v_payload || jsonb_build_object(
      'interactive_flow','getit_'||v_flow_kind||'_application_v1',
      'flow_kind',v_flow_kind,
      'flow_id',v_flow_id,
      'flow_screen',case v_flow_kind when 'shop' then 'SHOP_APPLICATION' else 'DRIVER_APPLICATION' end,
      'flow_token','getit:'||v_flow_kind||':'||v_conversation.id::text
    );
  end if;

  return query select * from public.queue_outbound_message(
    v_event.conversation_id,p_idempotency_key,v_conversation.external_contact_key,v_conversation.provider,
    v_message_type,btrim(p_body),v_payload,v_event.message_id,p_max_attempts
  );
end;
$function$;

revoke all on function public.process_partner_application_message_v4(uuid,bigint,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.process_partner_application_message_v4(uuid,bigint,text,text,jsonb,text) to service_role;
revoke all on function public.queue_decision_response_v3(bigint,text,text,jsonb,boolean,integer) from public,anon,authenticated;
grant execute on function public.queue_decision_response_v3(bigint,text,text,jsonb,boolean,integer) to service_role;

comment on function public.process_partner_application_message_v4(uuid,bigint,text,text,jsonb,text) is
  'Processes Getit native WhatsApp shop and driver Flow submissions; ordinary chat text can never populate application fields.';
comment on function public.queue_decision_response_v3(bigint,text,text,jsonb,boolean,integer) is
  'Queues canonical responses, the first-contact button menu, or an allowlisted Getit WhatsApp Flow form.';
