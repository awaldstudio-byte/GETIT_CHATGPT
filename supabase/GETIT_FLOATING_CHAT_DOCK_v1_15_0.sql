begin;

create or replace function private.normalize_messaging_phone(p_phone text)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
begin
  if v_digits like '00%' then
    v_digits := substr(v_digits, 3);
  elsif v_digits like '0%' then
    v_digits := '27' || substr(v_digits, 2);
  end if;

  if length(v_digits) not between 8 and 15 or v_digits like '0%' then
    return null;
  end if;
  return '+' || v_digits;
end;
$function$;

revoke all on function private.normalize_messaging_phone(text) from public;
revoke all on function private.normalize_messaging_phone(text) from anon;
revoke all on function private.normalize_messaging_phone(text) from authenticated;

create table if not exists public.messaging_conversation_participants (
  conversation_id uuid primary key references public.messaging_conversations(id) on delete cascade,
  participant_type text not null check (participant_type in ('driver', 'shop')),
  driver_id uuid references public.drivers(id) on delete cascade,
  shop_id uuid references public.shops(id) on delete cascade,
  display_name text not null check (btrim(display_name) <> ''),
  phone text not null check (btrim(phone) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint messaging_participant_entity_check check (
    (participant_type = 'driver' and driver_id is not null and shop_id is null)
    or (participant_type = 'shop' and shop_id is not null and driver_id is null)
  )
);

create unique index if not exists messaging_participant_driver_unique
  on public.messaging_conversation_participants(driver_id)
  where driver_id is not null;

create unique index if not exists messaging_participant_shop_unique
  on public.messaging_conversation_participants(shop_id)
  where shop_id is not null;

alter table public.messaging_conversation_participants enable row level security;
revoke all on table public.messaging_conversation_participants from public;
revoke all on table public.messaging_conversation_participants from anon;
revoke all on table public.messaging_conversation_participants from authenticated;
grant all on table public.messaging_conversation_participants to service_role;

comment on table public.messaging_conversation_participants is
  'Private operator mapping for driver and shop conversations in the Getit floating chat dock. Customer conversations continue to use customer_id.';

create or replace function public.get_messaging_dock_inbox(p_limit integer default 300)
returns table(
  conversation_id uuid,
  participant_type text,
  participant_id uuid,
  participant_name text,
  participant_phone text,
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
  requires_attention boolean,
  has_unread boolean,
  needs_attention boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
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
    coalesce(cp.participant_type, case when auto_driver.id is not null then 'driver' else 'customer' end),
    coalesce(case when cp.participant_type = 'driver' then cp.driver_id when cp.participant_type = 'shop' then cp.shop_id end, auto_driver.id, c.customer_id),
    coalesce(nullif(btrim(cp.display_name), ''), nullif(btrim(auto_driver.full_name), ''), nullif(btrim(cu.full_name), ''), 'WhatsApp customer'),
    coalesce(cp.phone, auto_driver.phone, cu.phone, c.external_contact_key),
    c.customer_id,
    coalesce(nullif(btrim(cp.display_name), ''), nullif(btrim(auto_driver.full_name), ''), nullif(btrim(cu.full_name), ''), 'WhatsApp customer'),
    coalesce(cp.phone, auto_driver.phone, cu.phone, c.external_contact_key),
    c.provider,
    c.channel,
    c.status,
    c.mode,
    c.assigned_staff_user_id,
    c.version,
    c.last_inbound_at,
    c.last_outbound_at,
    c.last_message_at,
    lm.id,
    lm.direction,
    lm.message_type,
    lm.body,
    lm.status,
    coalesce(unread.unread_count, 0)::bigint,
    coalesce(incidents.open_incident_count, 0)::bigint,
    coalesce(review.manual_review_count, 0)::bigint,
    coalesce(d.state ->> 'stage', 'idle'),
    coalesce(d.version, 0)::bigint,
    (
      c.mode in ('human', 'paused')
      or c.status = 'waiting_for_staff'
      or coalesce(incidents.open_incident_count, 0) > 0
      or coalesce(review.manual_review_count, 0) > 0
    ),
    coalesce(unread.unread_count, 0) > 0,
    (
      c.mode in ('human', 'paused')
      or c.status = 'waiting_for_staff'
      or coalesce(unread.unread_count, 0) > 0
      or coalesce(incidents.open_incident_count, 0) > 0
      or coalesce(review.manual_review_count, 0) > 0
    )
  from public.messaging_conversations c
  left join public.messaging_conversation_participants cp on cp.conversation_id = c.id
  left join lateral (
    select dr.id, dr.full_name, dr.phone
    from public.drivers dr
    where cp.conversation_id is null
      and private.normalize_messaging_phone(dr.phone) = private.normalize_messaging_phone(c.external_contact_key)
    order by dr.active desc, dr.updated_at desc
    limit 1
  ) auto_driver on true
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
    where i.conversation_id = c.id and i.status in ('open', 'investigating')
  ) incidents on true
  left join lateral (
    select count(*)::bigint as manual_review_count
    from public.messaging_messages m
    where m.conversation_id = c.id and m.status = 'manual_review'
  ) review on true
  left join public.messaging_order_drafts d on d.conversation_id = c.id
  where c.status <> 'closed'
  order by requires_attention desc, has_unread desc, c.last_message_at desc nulls last, c.created_at desc
  limit p_limit;
end;
$function$;

revoke all on function public.get_messaging_dock_inbox(integer) from public;
revoke all on function public.get_messaging_dock_inbox(integer) from anon;
grant execute on function public.get_messaging_dock_inbox(integer) to authenticated;
grant execute on function public.get_messaging_dock_inbox(integer) to service_role;

create or replace function public.get_messaging_chat_directory()
returns table(
  participant_type text,
  participant_id uuid,
  participant_name text,
  participant_phone text,
  participant_status text,
  conversation_id uuid,
  conversation_mode text,
  conversation_status text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'operations staff role required' using errcode = '42501';
  end if;

  return query
  select * from (
    select
      'driver'::text as participant_type,
      dr.id as participant_id,
      dr.full_name as participant_name,
      private.normalize_messaging_phone(dr.phone) as participant_phone,
      coalesce(dr.status, case when dr.active then 'active' else 'inactive' end) as participant_status,
      coalesce(mapped.id, direct.id) as conversation_id,
      coalesce(mapped.mode, direct.mode) as conversation_mode,
      coalesce(mapped.status, direct.status) as conversation_status
    from public.drivers dr
    left join public.messaging_conversation_participants cp on cp.driver_id = dr.id
    left join public.messaging_conversations mapped on mapped.id = cp.conversation_id and mapped.status <> 'closed'
    left join lateral (
      select c.id, c.mode, c.status
      from public.messaging_conversations c
      where cp.conversation_id is null
        and c.status <> 'closed'
        and private.normalize_messaging_phone(c.external_contact_key) = private.normalize_messaging_phone(dr.phone)
      order by c.last_message_at desc nulls last, c.created_at desc
      limit 1
    ) direct on true
    where dr.active = true

    union all

    select
      'shop'::text as participant_type,
      s.id as participant_id,
      s.name as participant_name,
      cp.phone as participant_phone,
      coalesce(nullif(btrim(s.town), ''), case when s.active then 'active' else 'inactive' end) as participant_status,
      c.id as conversation_id,
      c.mode as conversation_mode,
      c.status as conversation_status
    from public.shops s
    left join public.messaging_conversation_participants cp on cp.shop_id = s.id
    left join public.messaging_conversations c on c.id = cp.conversation_id and c.status <> 'closed'
    where s.active = true
  ) directory
  order by directory.participant_type, directory.participant_name;
end;
$function$;

revoke all on function public.get_messaging_chat_directory() from public;
revoke all on function public.get_messaging_chat_directory() from anon;
grant execute on function public.get_messaging_chat_directory() to authenticated;
grant execute on function public.get_messaging_chat_directory() to service_role;

create or replace function public.open_messaging_participant_conversation(
  p_participant_type text,
  p_participant_id uuid,
  p_phone text default null
)
returns table(
  conversation_id uuid,
  version bigint,
  participant_name text,
  participant_phone text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_type text := lower(btrim(coalesce(p_participant_type, '')));
  v_name text;
  v_phone text;
  v_driver_id uuid;
  v_shop_id uuid;
  v_conversation public.messaging_conversations%rowtype;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'operations staff role required' using errcode = '42501';
  end if;
  if v_type not in ('driver', 'shop') or p_participant_id is null then
    raise exception 'invalid messaging participant' using errcode = '22023';
  end if;

  select cp.conversation_id, cp.display_name, cp.phone, cp.driver_id, cp.shop_id
  into v_conversation.id, v_name, v_phone, v_driver_id, v_shop_id
  from public.messaging_conversation_participants cp
  where (v_type = 'driver' and cp.driver_id = p_participant_id)
     or (v_type = 'shop' and cp.shop_id = p_participant_id)
  limit 1;

  if v_conversation.id is null then
    if v_type = 'driver' then
      select dr.full_name, private.normalize_messaging_phone(dr.phone), dr.id
      into v_name, v_phone, v_driver_id
      from public.drivers dr
      where dr.id = p_participant_id and dr.active = true;
      if not found then raise exception 'active driver not found' using errcode = 'P0002'; end if;
    else
      select s.name, private.normalize_messaging_phone(p_phone), s.id
      into v_name, v_phone, v_shop_id
      from public.shops s
      where s.id = p_participant_id and s.active = true;
      if not found then raise exception 'active shop not found' using errcode = 'P0002'; end if;
    end if;

    if v_phone is null then
      raise exception 'a valid international phone number is required' using errcode = '22023';
    end if;

    insert into public.messaging_conversations(
      customer_id, provider, channel, external_contact_key, external_conversation_key,
      status, mode
    ) values (
      null, 'meta_whatsapp', 'whatsapp', v_phone, v_phone, 'open', 'dry_run'
    )
    on conflict (provider, channel, external_contact_key) do update
      set status = case when public.messaging_conversations.status = 'closed' then 'open' else public.messaging_conversations.status end,
          updated_at = now()
    returning * into v_conversation;

    insert into public.messaging_conversation_participants(
      conversation_id, participant_type, driver_id, shop_id, display_name, phone
    ) values (
      v_conversation.id, v_type, v_driver_id, v_shop_id, v_name, v_phone
    )
    on conflict (conversation_id) do update
      set participant_type = excluded.participant_type,
          driver_id = excluded.driver_id,
          shop_id = excluded.shop_id,
          display_name = excluded.display_name,
          phone = excluded.phone,
          updated_at = now();
  else
    select * into v_conversation
    from public.messaging_conversations c
    where c.id = v_conversation.id
    for update;
    if not found then raise exception 'linked conversation not found' using errcode = 'P0002'; end if;
  end if;

  if v_conversation.mode <> 'human' then
    perform public.set_messaging_conversation_mode_v2(
      v_conversation.id,
      'human',
      'Staff opened ' || v_type || ' chat from Getit floating dock',
      v_conversation.version
    );
    select * into v_conversation from public.messaging_conversations c where c.id = v_conversation.id;
  end if;

  return query select v_conversation.id, v_conversation.version, v_name, v_phone;
end;
$function$;

revoke all on function public.open_messaging_participant_conversation(text,uuid,text) from public;
revoke all on function public.open_messaging_participant_conversation(text,uuid,text) from anon;
grant execute on function public.open_messaging_participant_conversation(text,uuid,text) to authenticated;
grant execute on function public.open_messaging_participant_conversation(text,uuid,text) to service_role;

-- Preserve the old RPC contract for compatibility while removing its live Chatwoot table dependency.
create or replace function public.get_messaging_operator_inbox(p_limit integer default 200)
returns table(
  conversation_id uuid, customer_id uuid, customer_name text, customer_phone text,
  provider text, channel text, status text, mode text, assigned_staff_user_id uuid,
  version bigint, last_inbound_at timestamptz, last_outbound_at timestamptz,
  last_message_at timestamptz, last_message_id bigint, last_message_direction text,
  last_message_type text, last_message_body text, last_message_status text,
  unread_count bigint, open_incident_count bigint, manual_review_count bigint,
  draft_stage text, draft_version bigint, chatwoot_conversation_id bigint,
  needs_attention boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'operations staff role required' using errcode = '42501';
  end if;
  if p_limit not between 1 and 500 then raise exception 'invalid inbox limit' using errcode = '22023'; end if;

  return query
  select
    c.id, c.customer_id,
    coalesce(nullif(btrim(cu.full_name), ''), 'WhatsApp customer'), cu.phone,
    c.provider, c.channel, c.status, c.mode, c.assigned_staff_user_id, c.version,
    c.last_inbound_at, c.last_outbound_at, c.last_message_at,
    lm.id, lm.direction, lm.message_type, lm.body, lm.status,
    coalesce(unread.unread_count, 0)::bigint,
    coalesce(incidents.open_incident_count, 0)::bigint,
    coalesce(review.manual_review_count, 0)::bigint,
    coalesce(d.state ->> 'stage', 'idle'), coalesce(d.version, 0)::bigint,
    null::bigint,
    (
      c.mode in ('human', 'paused') or c.status = 'waiting_for_staff'
      or coalesce(unread.unread_count, 0) > 0
      or coalesce(incidents.open_incident_count, 0) > 0
      or coalesce(review.manual_review_count, 0) > 0
    )
  from public.messaging_conversations c
  left join public.customers cu on cu.id = c.customer_id
  left join public.messaging_operator_reads r on r.conversation_id = c.id and r.staff_user_id = auth.uid()
  left join lateral (
    select m.id, m.direction, m.message_type, m.body, m.status
    from public.messaging_messages m where m.conversation_id = c.id order by m.id desc limit 1
  ) lm on true
  left join lateral (
    select count(*)::bigint as unread_count
    from public.messaging_messages m
    where m.conversation_id = c.id and m.direction = 'inbound' and m.id > coalesce(r.last_read_message_id, 0)
  ) unread on true
  left join lateral (
    select count(*)::bigint as open_incident_count
    from public.messaging_incidents i where i.conversation_id = c.id and i.status in ('open', 'investigating')
  ) incidents on true
  left join lateral (
    select count(*)::bigint as manual_review_count
    from public.messaging_messages m where m.conversation_id = c.id and m.status = 'manual_review'
  ) review on true
  left join public.messaging_order_drafts d on d.conversation_id = c.id
  where c.status <> 'closed'
  order by c.last_message_at desc nulls last, c.created_at desc
  limit p_limit;
end;
$function$;

commit;
