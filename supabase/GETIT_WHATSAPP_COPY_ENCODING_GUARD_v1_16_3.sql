-- Keep Getit-authored WhatsApp application copy ASCII-safe end to end.
-- Customer-provided text is preserved; only our generated response_body is normalised.
create or replace function public.process_partner_application_message_v3(
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
  v_result jsonb;
  v_response text;
begin
  perform private.assert_messaging_service_role();
  v_result := public.process_partner_application_message_v2(
    p_conversation_id,p_message_id,p_message_type,p_body,p_payload,p_interactive_reply_id
  );

  v_response := v_result->>'response_body';
  if v_response is not null then
    -- Repair text already stored in a mojibake function definition.
    v_response := replace(v_response, ' ' || U&'\00E2\20AC\201D' || ' ', ' - ');
    v_response := replace(v_response, U&'\00E2\20AC\201D', '-');
    v_response := replace(v_response, U&'\00E2\20AC\2122', chr(39));
    -- Also remove punctuation that could be corrupted by a later Windows boundary.
    v_response := replace(v_response, ' ' || U&'\2014' || ' ', ' - ');
    v_response := replace(v_response, U&'\2014', '-');
    v_response := replace(v_response, U&'\2019', chr(39));
    v_result := jsonb_set(v_result, '{response_body}', to_jsonb(v_response), true);
  end if;
  return v_result;
end;
$function$;

revoke all on function public.process_partner_application_message_v3(uuid,bigint,text,text,jsonb,text)
from public,anon,authenticated;
grant execute on function public.process_partner_application_message_v3(uuid,bigint,text,text,jsonb,text)
to service_role;

comment on function public.process_partner_application_message_v3(uuid,bigint,text,text,jsonb,text) is
  'Mode-gated application handler with ASCII-safe Getit WhatsApp response copy.';
