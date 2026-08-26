-- Getit partner catalogue intake privacy and retry hardening v1.22.2
-- Catalogue media requires a short-lived explicit upload session.

create or replace function public.get_partner_catalogue_upload_context_v1(
  p_submission_id uuid,
  p_application_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_meta_media_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_submission public.partner_catalogue_submissions%rowtype;
  v_application public.partner_applications%rowtype;
begin
  perform private.assert_messaging_service_role();
  select * into v_submission
  from public.partner_catalogue_submissions s
  where s.id=p_submission_id
  for update;
  if not found then raise exception 'catalogue submission not found' using errcode='P0002'; end if;
  if v_submission.application_id<>p_application_id
     or v_submission.conversation_id<>p_conversation_id
     or v_submission.source_message_id<>p_message_id
     or v_submission.meta_media_id<>btrim(coalesce(p_meta_media_id,'')) then
    raise exception 'catalogue upload context mismatch' using errcode='42501';
  end if;
  if v_submission.status not in ('awaiting_upload','awaiting_kind','awaiting_validity','awaiting_refresh','ready_for_review') then
    raise exception 'catalogue submission is not uploadable' using errcode='55000';
  end if;
  select * into v_application
  from public.partner_applications a
  where a.id=v_submission.application_id
    and a.conversation_id=v_submission.conversation_id
    and a.application_type='shop'
    and a.status in ('submitted','reviewing','approved');
  if not found then raise exception 'shop application is not eligible for catalogue upload' using errcode='42501'; end if;
  return jsonb_build_object(
    'submission_id',v_submission.id,
    'application_id',v_submission.application_id,
    'conversation_id',v_submission.conversation_id,
    'message_id',v_submission.source_message_id,
    'meta_media_id',v_submission.meta_media_id,
    'status',v_submission.status,
    'existing_storage_bucket',v_submission.storage_bucket,
    'existing_storage_path',v_submission.storage_path,
    'existing_sha256',v_submission.sha256,
    'storage_bucket','getit-catalogue-sources',
    'storage_prefix','partner-applications/'||v_submission.application_id::text||'/'||v_submission.id::text||'/'
  );
end;
$function$;
revoke all on function public.get_partner_catalogue_upload_context_v1(uuid,uuid,uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.get_partner_catalogue_upload_context_v1(uuid,uuid,uuid,bigint,text) to service_role;

create or replace function public.process_partner_application_message_v5(
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
  v_submission public.partner_catalogue_submissions%rowtype;
  v_existing jsonb;
  v_result jsonb;
  v_body text:=left(btrim(coalesce(p_body,'')),2000);
  v_lower text:=lower(left(btrim(coalesce(p_body,'')),2000));
  v_media_id text;
  v_file_name text;
  v_mime_type text;
  v_date_parts text[];
  v_start date;
  v_end date;
  v_refresh date;
  v_upload_session jsonb:='{}'::jsonb;
  v_upload_expires timestamptz;
  v_local_date date:=(now() at time zone 'Africa/Johannesburg')::date;
begin
  perform private.assert_messaging_service_role();
  select r.result into v_existing from private.partner_application_message_receipts r where r.message_id=p_message_id;
  if found then return v_existing; end if;

  select * into v_conversation from public.messaging_conversations c where c.id=p_conversation_id for update;
  if not found then raise exception 'conversation not found' using errcode='P0002'; end if;
  -- A second worker may have waited on the conversation lock while the first
  -- completed this same message. Recheck the idempotency receipt after locking.
  select r.result into v_existing from private.partner_application_message_receipts r where r.message_id=p_message_id;
  if found then return v_existing; end if;
  if not exists(select 1 from public.messaging_messages m where m.id=p_message_id and m.conversation_id=p_conversation_id and m.direction='inbound') then
    raise exception 'inbound message not found' using errcode='P0002';
  end if;

  if v_conversation.mode<>'automation' then
    v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_AUTOMATION_MODE_BLOCKED','response_body',null,'requires_human',true);
    insert into private.partner_application_message_receipts(message_id,application_id,result) values(p_message_id,null,v_result) on conflict(message_id) do nothing;
    return v_result;
  end if;
  if v_lower ~ '(stop|unsubscribe|opt[ -]?out|do not message|moenie.*boodskap)' then
    v_result:=jsonb_build_object('handled',false,'reason_code','PARTNER_OPT_OUT_BYPASS');
    insert into private.partner_application_message_receipts(message_id,application_id,result) values(p_message_id,null,v_result) on conflict(message_id) do nothing;
    return v_result;
  end if;

  select * into v_application
  from public.partner_applications a
  where a.conversation_id=p_conversation_id and a.application_type='shop' and a.status in ('submitted','reviewing','approved')
  order by a.created_at desc limit 1 for update;

  if v_application.id is not null then
    v_upload_session:=coalesce(v_application.answers->'catalogue_upload_session','{}'::jsonb);
    begin
      v_upload_expires:=nullif(v_upload_session->>'expires_at','')::timestamptz;
    exception when others then
      v_upload_expires:=null;
    end;
  end if;

  if v_application.id is not null then
    select * into v_submission
    from public.partner_catalogue_submissions s
    where s.application_id=v_application.id and s.status in ('awaiting_upload','awaiting_kind','awaiting_validity','awaiting_refresh')
    order by s.created_at desc limit 1 for update;
  end if;

  if v_application.id is not null and p_message_type in ('image','document') then
    if v_upload_expires is null or v_upload_expires<=now() then
      update public.partner_applications
      set answers=answers-'catalogue_upload_session'
      where id=v_application.id and answers ? 'catalogue_upload_session';
      v_result:=jsonb_build_object(
        'handled',false,'reason_code','PARTNER_CATALOGUE_SESSION_REQUIRED',
        'response_body',null,'requires_human',true,
        'application_id',v_application.id,'application_type','shop','status',v_application.status
      );
    elsif v_submission.id is not null then
      v_result:=jsonb_build_object(
        'handled',true,'reason_code','PARTNER_CATALOGUE_IN_PROGRESS',
        'response_body','Please finish the catalogue already in progress, or reply CANCEL CATALOGUE before sending another file.',
        'application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id
      );
    else
      v_media_id:=case when p_message_type='image' then p_payload #>> '{message,image,id}' else p_payload #>> '{message,document,id}' end;
      v_file_name:=case when p_message_type='image' then coalesce(nullif(p_payload #>> '{message,image,filename}',''),'catalogue-image') else p_payload #>> '{message,document,filename}' end;
      v_mime_type:=case when p_message_type='image' then p_payload #>> '{message,image,mime_type}' else p_payload #>> '{message,document,mime_type}' end;
      if v_media_id is null or v_media_id !~ '^[0-9]{6,40}$' then
        v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_MEDIA_INVALID','response_body',null,'requires_human',true,'application_id',v_application.id,'application_type','shop','status',v_application.status);
      else
        insert into public.partner_catalogue_submissions(
          application_id,conversation_id,source_message_id,meta_media_id,original_file_name,declared_mime_type,status,current_step
        ) values(
          v_application.id,p_conversation_id,p_message_id,v_media_id,left(btrim(coalesce(v_file_name,'catalogue')),180),left(btrim(coalesce(v_mime_type,'')),120),'awaiting_upload','upload'
        ) returning * into v_submission;
        update public.partner_applications
        set answers=answers-'catalogue_upload_session'
        where id=v_application.id;
        v_result:=jsonb_build_object(
          'handled',true,'reason_code','PARTNER_CATALOGUE_UPLOAD_REQUIRED','response_body',null,
          'application_id',v_application.id,'application_type','shop','status',v_application.status,
          'submission_id',v_submission.id,'media_upload_required',true,'meta_media_id',v_media_id
        );
      end if;
    end if;

  elsif v_submission.id is not null and v_lower in ('cancel catalogue','cancel catalog','cancel upload','stop catalogue') then
    update public.partner_catalogue_submissions set status='withdrawn',current_step='cancelled' where id=v_submission.id;
    update public.partner_applications set answers=answers-'catalogue_upload_session' where id=v_application.id;
    v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_CANCELLED','response_body','Okay, I cancelled that catalogue upload. You can send a new file whenever you are ready.','application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id);

  elsif v_submission.id is not null and v_submission.status='awaiting_upload' then
    v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_UPLOAD_PENDING','response_body',null,'requires_human',true,'application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id);

  elsif v_submission.id is not null and v_submission.status='awaiting_kind' then
    if v_lower in ('1','special','specials','specials flyer','flyer') then
      update public.partner_catalogue_submissions set catalogue_kind='specials',status='awaiting_validity',current_step='validity' where id=v_submission.id returning * into v_submission;
      v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_VALIDITY_REQUESTED','response_body','Send the specials dates as YYYY-MM-DD to YYYY-MM-DD. Example: 2026-08-25 to 2026-08-31. Specials are never published without an end date.','application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id);
    elsif v_lower in ('2','regular','catalogue','catalog','menu','price list','pricelist') then
      update public.partner_catalogue_submissions set catalogue_kind='regular',status='awaiting_refresh',current_step='refresh' where id=v_submission.id returning * into v_submission;
      v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_REFRESH_REQUESTED','response_body','When should Getit expect the next catalogue? Reply weekly, fortnightly, monthly, quarterly, or send an exact date as YYYY-MM-DD.','application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id);
    elsif v_lower in ('3','both','mixed','catalogue and specials','catalog and specials') then
      update public.partner_catalogue_submissions set catalogue_kind='mixed',status='awaiting_validity',current_step='validity' where id=v_submission.id returning * into v_submission;
      v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_VALIDITY_REQUESTED','response_body','Send the specials dates as YYYY-MM-DD to YYYY-MM-DD. Example: 2026-08-25 to 2026-08-31. Getit will expect the next update the day after the specials end.','application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id);
    else
      v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_KIND_REQUIRED','response_body','Reply 1 for a specials flyer, 2 for a regular catalogue or menu, or 3 if it contains both.','application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id);
    end if;

  elsif v_submission.id is not null and v_submission.status='awaiting_validity' then
    v_date_parts:=regexp_match(v_body,'([0-9]{4}-[0-9]{2}-[0-9]{2})[[:space:]]*(?:to|until|through|-)[[:space:]]*([0-9]{4}-[0-9]{2}-[0-9]{2})','i');
    begin
      if v_date_parts is not null then v_start:=v_date_parts[1]::date; v_end:=v_date_parts[2]::date; end if;
    exception when others then v_start:=null; v_end:=null; end;
    if v_start is null or v_end is null or v_end<v_start or v_end<v_local_date or v_end-v_start>366 then
      v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_VALIDITY_INVALID','response_body','Please use two real dates in this format: YYYY-MM-DD to YYYY-MM-DD. The end date cannot be before the start date or already expired.','application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id);
    else
      update public.partner_catalogue_submissions
      set valid_from=v_start,valid_to=v_end,expected_refresh_on=v_end+1,refresh_cadence='exact_date',status='ready_for_review',current_step='completed',
          answers=answers||jsonb_build_object('villiers_business_date',v_local_date,'specials_auto_expire_after',v_end)
      where id=v_submission.id returning * into v_submission;
      v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_READY_FOR_REVIEW','response_body','Saved. The specials are marked valid from '||v_start::text||' through '||v_end::text||' and will expire automatically after that Villiers business day. Getit expects the next update on '||(v_end+1)::text||'. A staff member will review the file before anything can go live.','application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id,'catalogue_submission_status','ready_for_review');
    end if;

  elsif v_submission.id is not null and v_submission.status='awaiting_refresh' then
    if v_lower='weekly' then v_refresh:=v_local_date+7; elsif v_lower in ('fortnightly','every two weeks','biweekly') then v_refresh:=v_local_date+14;
    elsif v_lower='monthly' then v_refresh:=(v_local_date+interval '1 month')::date;
    elsif v_lower='quarterly' then v_refresh:=(v_local_date+interval '3 months')::date;
    elsif v_body ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then begin v_refresh:=v_body::date; exception when others then v_refresh:=null; end;
    else v_refresh:=null; end if;
    if v_refresh is null or v_refresh<=v_local_date or v_refresh>v_local_date+730 then
      v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_REFRESH_INVALID','response_body','Reply weekly, fortnightly, monthly, quarterly, or send a future date as YYYY-MM-DD.','application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id);
    else
      update public.partner_catalogue_submissions
      set expected_refresh_on=v_refresh,
          refresh_cadence=case when v_lower='weekly' then 'weekly' when v_lower in ('fortnightly','every two weeks','biweekly') then 'fortnightly' when v_lower='monthly' then 'monthly' when v_lower='quarterly' then 'quarterly' else 'exact_date' end,
          status='ready_for_review',current_step='completed',answers=answers||jsonb_build_object('villiers_business_date',v_local_date)
      where id=v_submission.id returning * into v_submission;
      v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_READY_FOR_REVIEW','response_body','Saved. Getit expects the next catalogue update on '||v_refresh::text||'. A staff member will review this file before anything can go live.','application_id',v_application.id,'application_type','shop','status',v_application.status,'submission_id',v_submission.id,'catalogue_submission_status','ready_for_review');
    end if;

  elsif v_application.id is not null and v_lower in ('upload catalogue','upload catalog','send catalogue','send catalog','catalogue upload') then
    update public.partner_applications
    set answers=jsonb_set(
      answers,
      '{catalogue_upload_session}',
      jsonb_build_object('opened_at',now(),'expires_at',now()+interval '30 minutes','request_message_id',p_message_id),
      true
    )
    where id=v_application.id
    returning * into v_application;
    v_result:=jsonb_build_object('handled',true,'reason_code','PARTNER_CATALOGUE_FILE_REQUESTED','response_body','Send one catalogue here within 30 minutes as a PDF, JPG, PNG, WEBP, CSV or XLSX file up to 25 MB. It stays private and review-only until the Getit team approves it.','application_id',v_application.id,'application_type','shop','status',v_application.status,'upload_session_expires_at',v_application.answers #>> '{catalogue_upload_session,expires_at}');

  else
    v_result:=public.process_partner_application_message_v4(p_conversation_id,p_message_id,p_message_type,p_body,p_payload,p_interactive_reply_id);
    if v_result->>'reason_code'='SHOP_APPLICATION_SUBMITTED' then
      update public.partner_applications
      set business_type=case business_type
        when 'grocery_general' then 'Grocery / supermarket / general dealer'
        when 'convenience_spaza' then 'Convenience / spaza'
        when 'butchery_fresh_food' then 'Butchery / fresh food'
        when 'bakery_takeaway' then 'Bakery / restaurant / takeaway'
        when 'pharmacy_health_beauty' then 'Pharmacy / health / beauty'
        when 'hardware_agri_garden' then 'Hardware / building / agri / garden'
        when 'veterinary_pet' then 'Veterinary / pet supplies'
        when 'clothing_homeware' then 'Clothing / footwear / homeware'
        when 'automotive_electronics' then 'Automotive / electronics / appliances'
        when 'licensed_restricted' then 'Licensed liquor / tobacco - separate compliance review required'
        when 'other' then 'Other'
        else business_type end,
          answers=answers||jsonb_build_object('business_type_code',coalesce(answers->>'business_type',business_type))
      where id=nullif(v_result->>'application_id','')::uuid;
      v_result:=jsonb_set(v_result,'{response_body}',to_jsonb('Thank you - your shop application has been sent to the Getit team for review. If you have a catalogue, menu, price list or specials flyer, reply UPLOAD CATALOGUE when you are ready. Nothing goes live without staff review.'::text));
      update private.partner_application_message_receipts set result=v_result,processed_at=now() where message_id=p_message_id;
    end if;
    return v_result;
  end if;

  insert into private.partner_application_message_receipts(message_id,application_id,result)
  values(p_message_id,v_application.id,v_result)
  on conflict(message_id) do update set application_id=excluded.application_id,result=excluded.result,processed_at=now();
  return v_result;
end;
$function$;
revoke all on function public.process_partner_application_message_v5(uuid,bigint,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.process_partner_application_message_v5(uuid,bigint,text,text,jsonb,text) to service_role;

