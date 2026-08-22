begin;

create table if not exists public.messaging_operator_reads (
  conversation_id uuid not null references public.messaging_conversations(id) on delete cascade,
  staff_user_id uuid not null references public.staff_accounts(user_id) on delete cascade,
  last_read_message_id bigint references public.messaging_messages(id) on delete set null,
  read_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, staff_user_id)
);

comment on table public.messaging_operator_reads is
  'Per-staff durable read cursor for the Getit messaging inbox.';

alter table public.messaging_operator_reads enable row level security;
revoke all on table public.messaging_operator_reads from public, anon, authenticated;

create or replace function public.get_messaging_operator_inbox(
  p_limit integer default 200
)
returns table (
  conversation_id uuid,
  customer_id uuid,
  customer_name text,
  customer_phone text,
  provider text,
  channel text,
  status text,
  mode text,
  assigned_staff_user_id uuid,
  version bigint,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_message_at timestamptz,
  last_message_id bigint,
  last_message_direction text,
  last_message_type text,
  last_message_body text,
  last_message_status text,
  unread_count bigint,
  open_incident_count bigint,
  manual_review_count bigint,
  draft_stage text,
  draft_version bigint,
  chatwoot_conversation_id bigint,
  needs_attention boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'operations staff role required' using errcode = '42501';
  end if;
  if p_limit not between 1 and 500 then
    raise exception 'invalid inbox limit' using errcode = '22023';
  end if;

  return query
  select
    c.id,
    c.customer_id,
    coalesce(nullif(btrim(cu.full_name), ''), 'WhatsApp customer') as customer_name,
    cu.phone as customer_phone,
    c.provider,
    c.channel,
    c.status,
    c.mode,
    c.assigned_staff_user_id,
    c.version,
    c.last_inbound_at,
    c.last_outbound_at,
    c.last_message_at,
    lm.id as last_message_id,
    lm.direction as last_message_direction,
    lm.message_type as last_message_type,
    lm.body as last_message_body,
    lm.status as last_message_status,
    coalesce(unread.unread_count, 0)::bigint,
    coalesce(incidents.open_incident_count, 0)::bigint,
    coalesce(review.manual_review_count, 0)::bigint,
    coalesce(d.state ->> 'stage', 'idle') as draft_stage,
    coalesce(d.version, 0)::bigint as draft_version,
    cw.chatwoot_conversation_id,
    (
      c.mode in ('human', 'paused')
      or c.status = 'waiting_for_staff'
      or coalesce(unread.unread_count, 0) > 0
      or coalesce(incidents.open_incident_count, 0) > 0
      or coalesce(review.manual_review_count, 0) > 0
    ) as needs_attention
  from public.messaging_conversations c
  left join public.customers cu on cu.id = c.customer_id
  left join public.messaging_operator_reads r
    on r.conversation_id = c.id and r.staff_user_id = auth.uid()
  left join lateral (
    select m.id, m.direction, m.message_type, m.body, m.status
    from public.messaging_messages m
    where m.conversation_id = c.id
    order by m.id desc
    limit 1
  ) lm on true
  left join lateral (
    select count(*)::bigint as unread_count
    from public.messaging_messages m
    where m.conversation_id = c.id
      and m.direction = 'inbound'
      and m.id > coalesce(r.last_read_message_id, 0)
  ) unread on true
  left join lateral (
    select count(*)::bigint as open_incident_count
    from public.messaging_incidents i
    where i.conversation_id = c.id
      and i.status in ('open', 'investigating')
  ) incidents on true
  left join lateral (
    select count(*)::bigint as manual_review_count
    from public.messaging_messages m
    where m.conversation_id = c.id and m.status = 'manual_review'
  ) review on true
  left join public.messaging_order_drafts d on d.conversation_id = c.id
  left join public.messaging_chatwoot_links cw on cw.conversation_id = c.id
  where c.status <> 'closed'
  order by needs_attention desc, c.last_message_at desc nulls last, c.created_at desc
  limit p_limit;
end;
$$;

create or replace function public.mark_messaging_conversation_read(
  p_conversation_id uuid,
  p_last_message_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff_user_id uuid := auth.uid();
  v_last_message_id bigint;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'operations staff role required' using errcode = '42501';
  end if;
  if v_staff_user_id is null then
    raise exception 'authenticated staff required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.messaging_conversations c where c.id = p_conversation_id) then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;

  if p_last_message_id is not null and not exists (
    select 1 from public.messaging_messages m
    where m.id = p_last_message_id and m.conversation_id = p_conversation_id
  ) then
    raise exception 'message does not belong to conversation' using errcode = '22023';
  end if;

  select coalesce(p_last_message_id, max(m.id))
  into v_last_message_id
  from public.messaging_messages m
  where m.conversation_id = p_conversation_id;

  insert into public.messaging_operator_reads(
    conversation_id, staff_user_id, last_read_message_id, read_at, updated_at
  ) values (
    p_conversation_id, v_staff_user_id, v_last_message_id, now(), now()
  )
  on conflict (conversation_id, staff_user_id) do update
  set last_read_message_id = case
        when excluded.last_read_message_id is null then public.messaging_operator_reads.last_read_message_id
        else greatest(coalesce(public.messaging_operator_reads.last_read_message_id, 0), excluded.last_read_message_id)
      end,
      read_at = now(),
      updated_at = now();

  return jsonb_build_object(
    'conversation_id', p_conversation_id,
    'last_read_message_id', v_last_message_id,
    'read_at', now()
  );
end;
$$;

revoke all on function public.get_messaging_operator_inbox(integer) from public, anon;
revoke all on function public.mark_messaging_conversation_read(uuid, bigint) from public, anon;
grant execute on function public.get_messaging_operator_inbox(integer) to authenticated, service_role;
grant execute on function public.mark_messaging_conversation_read(uuid, bigint) to authenticated, service_role;

commit;
