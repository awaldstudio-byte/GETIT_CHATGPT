begin;

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
    on conflict on constraint messaging_conversation_participants_pkey do update
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

commit;
