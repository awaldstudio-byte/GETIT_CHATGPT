-- Safe operator conversation reset and the four-choice first-AI-message menu.
-- Supabase remains authoritative; reset preserves only a minimal audit record and
-- processed event tombstones so old Meta webhook deliveries cannot be replayed.

create table if not exists private.messaging_conversation_resets (
  id bigint generated always as identity primary key,
  conversation_id uuid not null,
  reset_by uuid,
  reason text not null,
  previous_mode text not null,
  removed_counts jsonb not null default '{}'::jsonb,
  reset_at timestamptz not null default now(),
  constraint messaging_conversation_resets_reason_nonempty check (btrim(reason) <> ''),
  constraint messaging_conversation_resets_previous_mode_check
    check (previous_mode in ('automation','human','paused','dry_run'))
);

revoke all on table private.messaging_conversation_resets from public, anon, authenticated;
grant all on table private.messaging_conversation_resets to service_role;

create or replace function public.reset_messaging_conversation_v1(
  p_conversation_id uuid,
  p_expected_version bigint,
  p_reason text default 'Operator started a fresh conversation'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_conversation public.messaging_conversations%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_removed_counts jsonb;
  v_reset_id bigint;
  v_event_ids bigint[] := '{}'::bigint[];
begin
  if public.current_staff_role() not in ('owner','admin','dispatcher') then
    raise exception 'operations staff role required' using errcode = '42501';
  end if;
  if v_reason = '' or length(v_reason) > 500 then
    raise exception 'reset reason must be 1 to 500 characters' using errcode = '22023';
  end if;

  select * into v_conversation
  from public.messaging_conversations
  where id = p_conversation_id
  for update;

  if not found then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  if p_expected_version is null or v_conversation.version <> p_expected_version then
    raise exception 'conversation changed; refresh and try again' using errcode = '40001';
  end if;

  if exists (
    select 1
    from private.messaging_outbox o
    where o.conversation_id = p_conversation_id and o.status = 'processing'
  ) or exists (
    select 1
    from private.messaging_inbox_events e
    where e.status = 'processing'
      and (
        e.conversation_id = p_conversation_id
        or coalesce(e.payload #>> '{normalized,externalContactKey}', '') = v_conversation.external_contact_key
      )
  ) then
    raise exception 'a message is being processed; wait a moment and try again' using errcode = '55000';
  end if;

  select coalesce(array_agg(e.id), '{}'::bigint[])
  into v_event_ids
  from private.messaging_inbox_events e
  where e.conversation_id = p_conversation_id
     or coalesce(e.payload #>> '{normalized,externalContactKey}', '') = v_conversation.external_contact_key;

  select jsonb_build_object(
    'messages', (select count(*) from public.messaging_messages m where m.conversation_id = p_conversation_id),
    'decisions', (select count(*) from private.messaging_decisions d where d.inbox_event_id = any(v_event_ids)),
    'inbox_events', cardinality(v_event_ids),
    'outbox', (select count(*) from private.messaging_outbox o where o.conversation_id = p_conversation_id),
    'delivery_attempts', (
      select count(*)
      from private.messaging_delivery_attempts a
      join private.messaging_outbox o on o.id = a.outbox_id
      where o.conversation_id = p_conversation_id
    ),
    'handoffs', (select count(*) from public.messaging_handoff_events h where h.conversation_id = p_conversation_id),
    'incidents', (select count(*) from public.messaging_incidents i where i.conversation_id = p_conversation_id),
    'drafts', (select count(*) from public.messaging_order_drafts d where d.conversation_id = p_conversation_id)
  ) into v_removed_counts;

  insert into private.messaging_conversation_resets(
    conversation_id, reset_by, reason, previous_mode, removed_counts
  ) values (
    p_conversation_id, auth.uid(), v_reason, v_conversation.mode, v_removed_counts
  ) returning id into v_reset_id;

  delete from public.messaging_incidents i
  where i.conversation_id = p_conversation_id;

  delete from private.messaging_decisions d
  where d.inbox_event_id = any(v_event_ids);

  update private.messaging_inbox_events e
  set conversation_id = null,
      message_id = null,
      payload = jsonb_build_object(
        'cleared', true,
        'conversation_reset_id', v_reset_id,
        'original_event_type', e.event_type
      ),
      status = case when e.status in ('pending','processing') then 'quarantined' else e.status end,
      outcome = 'operator_fresh_start_reset',
      locked_at = null,
      locked_until = null,
      lock_token = null,
      worker_id = null,
      last_error_code = null,
      last_error_detail = null,
      updated_at = now()
  where e.id = any(v_event_ids);

  delete from private.messaging_outbox o
  where o.conversation_id = p_conversation_id;

  delete from public.messaging_handoff_events h
  where h.conversation_id = p_conversation_id;

  delete from public.messaging_operator_reads r
  where r.conversation_id = p_conversation_id;

  delete from public.messaging_order_drafts d
  where d.conversation_id = p_conversation_id;

  delete from public.messaging_messages m
  where m.conversation_id = p_conversation_id;

  update public.messaging_conversations
  set status = 'open',
      assigned_staff_user_id = null,
      last_inbound_at = null,
      last_outbound_at = null,
      last_message_at = null,
      version = version + 1,
      updated_at = now()
  where id = p_conversation_id;

  return jsonb_build_object(
    'conversation_id', p_conversation_id,
    'reset_id', v_reset_id,
    'mode', v_conversation.mode,
    'version', v_conversation.version + 1,
    'removed_counts', v_removed_counts,
    'fresh', true
  );
end;
$function$;

create or replace function public.mark_messaging_conversation_unread_v1(
  p_conversation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if public.current_staff_role() not in ('owner','admin','dispatcher') then
    raise exception 'operations staff role required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.messaging_conversations c where c.id = p_conversation_id) then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;

  delete from public.messaging_operator_reads r
  where r.conversation_id = p_conversation_id
    and r.staff_user_id = auth.uid();

  return jsonb_build_object('conversation_id', p_conversation_id, 'marked_unread', true);
end;
$function$;

create or replace function public.queue_decision_response_v4(
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
set search_path = ''
as $function$
declare
  v_event private.messaging_inbox_events%rowtype;
  v_decision private.messaging_decisions%rowtype;
  v_conversation public.messaging_conversations%rowtype;
  v_message public.messaging_messages%rowtype;
  v_window_started_at timestamptz;
  v_offer boolean := false;
  v_payload jsonb;
  v_message_type text := 'text';
  v_flow_kind text := lower(btrim(coalesce(p_payload->>'flow_kind','')));
  v_response_ui text := lower(btrim(coalesce(p_payload->>'response_ui','')));
  v_flow_id text;
begin
  perform private.assert_messaging_service_role();
  if p_body is null or btrim(p_body) = '' or length(p_body) > 12000 then
    raise exception 'response body must be 1 to 12000 characters' using errcode = '22023';
  end if;
  if pg_column_size(coalesce(p_payload,'{}'::jsonb)) > 262144 then
    raise exception 'response payload exceeds 256 KiB' using errcode = '22023';
  end if;
  if v_flow_kind not in ('','shop','driver') then
    raise exception 'invalid partner flow kind' using errcode = '22023';
  end if;
  if v_response_ui not in ('','specials_menu') then
    raise exception 'invalid response UI' using errcode = '22023';
  end if;

  select * into v_event from private.messaging_inbox_events where id = p_event_id;
  if not found then raise exception 'inbox event not found' using errcode = 'P0002'; end if;
  select * into v_decision
  from private.messaging_decisions
  where inbox_event_id = p_event_id and is_final
  order by decision_version desc
  limit 1;
  if not found then raise exception 'final response decision not found' using errcode = 'P0002'; end if;
  if v_decision.decision not in ('respond_now','light_ack')
     or not v_decision.schema_valid or not v_decision.facts_valid then
    return query select null::bigint,null::bigint,'suppressed'::text;
    return;
  end if;
  if v_event.conversation_id is null or v_event.message_id is null then
    raise exception 'event has not been attached to a conversation and message' using errcode = '22023';
  end if;

  select * into v_conversation from public.messaging_conversations where id = v_event.conversation_id;
  select * into v_message from public.messaging_messages where id = v_event.message_id;
  if v_conversation.id is null or v_message.id is null then
    raise exception 'conversation or inbound message not found' using errcode = 'P0002';
  end if;

  if p_offer_welcome_menu then
    with inbound as (
      select
        m.created_at,
        m.id,
        lag(m.created_at) over (order by m.created_at, m.id) as previous_created_at
      from public.messaging_messages m
      where m.conversation_id = v_event.conversation_id
        and m.direction = 'inbound'
        and (
          m.created_at < v_message.created_at
          or (m.created_at = v_message.created_at and m.id <= v_message.id)
        )
    )
    select max(i.created_at)
    into v_window_started_at
    from inbound i
    where i.previous_created_at is null
       or i.created_at > i.previous_created_at + interval '24 hours';

    v_offer := not exists (
      select 1
      from public.messaging_messages m
      where m.conversation_id = v_event.conversation_id
        and m.direction = 'outbound'
        and m.message_type = 'interactive_menu'
        and m.created_at >= coalesce(v_window_started_at, v_message.created_at)
        and coalesce(m.payload->>'interactive_menu','') in ('getit_first_contact_v1','getit_first_contact_v2')
    );
  end if;

  -- The first AI message of every customer 24-hour window always carries the
  -- main four-choice menu. Direct specials/forms are offered on later turns.
  if v_offer then
    v_message_type := 'interactive_menu';
  elsif v_flow_kind <> '' then
    select s.value #>> '{}' into v_flow_id
    from public.app_settings s
    where s.key = case v_flow_kind
      when 'shop' then 'whatsapp_shop_application_flow_id'
      else 'whatsapp_driver_application_flow_id'
    end;
    if v_flow_id is null or v_flow_id !~ '^[0-9]+$' then
      raise exception 'partner flow is not configured' using errcode = '55000';
    end if;
    v_message_type := 'interactive_flow';
  elsif v_response_ui = 'specials_menu' then
    v_message_type := 'interactive_specials_menu';
  end if;

  v_payload := coalesce(p_payload,'{}'::jsonb) || jsonb_build_object(
    'response_decision',v_decision.decision,
    'decision_reason',v_decision.reason_code,
    'prompt_version',v_decision.prompt_version
  );
  if v_offer then
    v_payload := v_payload || jsonb_build_object(
      'interactive_menu','getit_first_contact_v2',
      'customer_window_started_at',coalesce(v_window_started_at,v_message.created_at)
    );
  end if;
  if v_response_ui = 'specials_menu' and not v_offer then
    v_payload := v_payload || jsonb_build_object('interactive_specials_menu','getit_specials_browser_v1');
  end if;
  if v_flow_kind <> '' and not v_offer then
    v_payload := v_payload || jsonb_build_object(
      'interactive_flow','getit_'||v_flow_kind||'_application_v1',
      'flow_kind',v_flow_kind,
      'flow_id',v_flow_id,
      'flow_screen',case v_flow_kind when 'shop' then 'SHOP_APPLICATION' else 'DRIVER_APPLICATION' end,
      'flow_token','getit:'||v_flow_kind||':'||v_conversation.id::text
    );
  end if;

  return query select * from public.queue_outbound_message(
    v_event.conversation_id,
    p_idempotency_key,
    v_conversation.external_contact_key,
    v_conversation.provider,
    v_message_type,
    btrim(p_body),
    v_payload,
    v_event.message_id,
    p_max_attempts
  );
end;
$function$;

revoke all on function public.reset_messaging_conversation_v1(uuid,bigint,text) from public, anon;
revoke all on function public.mark_messaging_conversation_unread_v1(uuid) from public, anon;
revoke all on function public.queue_decision_response_v4(bigint,text,text,jsonb,boolean,integer) from public, anon, authenticated;

grant execute on function public.reset_messaging_conversation_v1(uuid,bigint,text) to authenticated, service_role;
grant execute on function public.mark_messaging_conversation_unread_v1(uuid) to authenticated, service_role;
grant execute on function public.queue_decision_response_v4(bigint,text,text,jsonb,boolean,integer) to service_role;

comment on function public.reset_messaging_conversation_v1(uuid,bigint,text) is
  'Starts a fresh operator-visible and AI context while retaining only a minimal reset audit and sanitized webhook tombstones.';
comment on function public.queue_decision_response_v4(bigint,text,text,jsonb,boolean,integer) is
  'Queues canonical AI replies, the first-AI-message four-choice menu for each customer 24-hour window, specials browsing, or an allowlisted partner Flow.';
