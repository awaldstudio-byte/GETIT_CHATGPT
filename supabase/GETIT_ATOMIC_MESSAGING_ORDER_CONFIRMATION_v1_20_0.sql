-- Accept natural customer confirmations and make confirmation + submission atomic.

create or replace function public.confirm_messaging_order_draft_v2(
  p_conversation_id uuid,
  p_expected_version bigint,
  p_confirmation_message_id bigint
)
returns public.messaging_order_drafts
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_draft public.messaging_order_drafts%rowtype;
  v_message public.messaging_messages%rowtype;
  v_body text;
  v_expected_fingerprint text;
  v_result public.messaging_order_drafts%rowtype;
begin
  perform private.assert_messaging_service_role();

  select * into v_draft
  from public.messaging_order_drafts
  where conversation_id = p_conversation_id
  for update;

  if not found then
    raise exception 'order draft not found' using errcode = 'P0002';
  end if;
  if p_expected_version is null or v_draft.version <> p_expected_version then
    raise exception 'draft state changed; refresh before confirmation' using errcode = '40001';
  end if;
  if coalesce(v_draft.state->>'stage', '') <> 'awaiting_confirmation' then
    raise exception 'draft is not awaiting confirmation' using errcode = '22023';
  end if;

  v_expected_fingerprint := encode(
    extensions.digest(convert_to(v_draft.state::text, 'utf8'), 'sha256'),
    'hex'
  );
  if v_draft.confirmation_fingerprint is null
     or v_draft.confirmation_fingerprint <> v_expected_fingerprint then
    raise exception 'draft confirmation fingerprint changed' using errcode = '40001';
  end if;

  select * into v_message
  from public.messaging_messages
  where id = p_confirmation_message_id
    and conversation_id = p_conversation_id
    and direction = 'inbound';

  if not found then
    raise exception 'confirmation message is invalid' using errcode = '22023';
  end if;
  if v_draft.source_message_id is not null
     and p_confirmation_message_id <= v_draft.source_message_id then
    raise exception 'confirmation must follow the draft request' using errcode = '22023';
  end if;

  v_body := lower(regexp_replace(btrim(coalesce(v_message.body, '')), '[.!?,[:space:]]+', ' ', 'g'));
  v_body := btrim(v_body);
  if v_body !~ '^(yes|yes confirm|yes please|confirm|confirmed|correct|that s correct|that is correct|this is correct|that s right|that is right|looks right|exactly|go ahead|ja|ja confirm|reg so)$' then
    raise exception 'explicit confirmation wording required' using errcode = '22023';
  end if;

  update public.messaging_order_drafts
  set state = jsonb_set(v_draft.state, '{stage}', '"confirmed"'::jsonb, true),
      source_message_id = p_confirmation_message_id,
      confirmed_by_message_id = p_confirmation_message_id,
      confirmed_at = now(),
      version = version + 1,
      updated_at = now()
  where conversation_id = p_conversation_id
    and version = p_expected_version
  returning * into v_result;

  if not found then
    raise exception 'draft state changed; refresh before confirmation' using errcode = '40001';
  end if;

  return v_result;
end;
$function$;

create or replace function public.confirm_and_submit_messaging_order_draft_v1(
  p_conversation_id uuid,
  p_expected_version bigint,
  p_confirmation_message_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_confirmed public.messaging_order_drafts%rowtype;
begin
  perform private.assert_messaging_service_role();

  v_confirmed := public.confirm_messaging_order_draft_v2(
    p_conversation_id,
    p_expected_version,
    p_confirmation_message_id
  );

  return public.submit_saved_messaging_order_draft(
    p_conversation_id,
    v_confirmed.version,
    p_confirmation_message_id
  );
end;
$function$;

revoke all on function public.confirm_and_submit_messaging_order_draft_v1(uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.confirm_and_submit_messaging_order_draft_v1(uuid, bigint, bigint) to service_role;

comment on function public.confirm_and_submit_messaging_order_draft_v1(uuid, bigint, bigint)
is 'Atomically confirms the exact persisted messaging draft and submits it through provider-neutral order intake.';
