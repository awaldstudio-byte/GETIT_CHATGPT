-- Never advance automated application state while AI does not own the chat.
create or replace function public.process_partner_application_message_v2(
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
declare v_mode text;
begin
  perform private.assert_messaging_service_role();
  select c.mode into v_mode
  from public.messaging_conversations c
  where c.id=p_conversation_id;
  if not found then raise exception 'conversation not found' using errcode='P0002'; end if;

  if v_mode <> 'automation' then
    return jsonb_build_object('handled',false,'suppressed_by_mode',v_mode);
  end if;

  return public.process_partner_application_message(
    p_conversation_id,p_message_id,p_message_type,p_body,p_payload,p_interactive_reply_id
  );
end;
$function$;

revoke all on function public.process_partner_application_message_v2(uuid,bigint,text,text,jsonb,text)
from public,anon,authenticated;
grant execute on function public.process_partner_application_message_v2(uuid,bigint,text,text,jsonb,text)
to service_role;

comment on function public.process_partner_application_message_v2(uuid,bigint,text,text,jsonb,text) is
  'Mode-gated partner application handler. Only automation-owned conversations may advance a form.';
