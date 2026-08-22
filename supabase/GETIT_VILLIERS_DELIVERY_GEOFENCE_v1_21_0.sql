begin;

-- Villiers town centre is -27.029719, 28.600826. A deliberately generous
-- 12 km radius includes Villiers and Qalabotjha while rejecting pins from
-- other towns. This is a database boundary: workflow checks remain the first
-- customer-friendly guard, but an alternate service path cannot bypass it.
create or replace function private.getit_is_within_villiers_delivery_radius(
  p_latitude numeric,
  p_longitude numeric
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $function$
  select case
    when p_latitude not between -90 and 90
      or p_longitude not between -180 and 180
      then false
    else 6371.0 * acos(
      least(1.0, greatest(-1.0,
        sin(radians(-27.029719::double precision)) * sin(radians(p_latitude::double precision))
        + cos(radians(-27.029719::double precision)) * cos(radians(p_latitude::double precision))
          * cos(radians((p_longitude - 28.600826)::double precision))
      ))
    ) <= 12.0
  end;
$function$;

create or replace function private.enforce_getit_order_delivery_geofence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_messaging_conversation_id uuid;
  v_conversation_mode text;
begin
  if lower(coalesce(new.source_channel, '')) <> 'whatsapp' then
    return new;
  end if;

  if (new.delivery_latitude is null) <> (new.delivery_longitude is null) then
    raise exception 'LOCATION_COORDINATES_INCOMPLETE' using errcode = '22023';
  end if;

  if new.delivery_latitude is not null
     and not private.getit_is_within_villiers_delivery_radius(
       new.delivery_latitude,
       new.delivery_longitude
     ) then
    raise exception 'LOCATION_OUTSIDE_VILLIERS' using errcode = '22023';
  end if;

  if nullif(btrim(new.delivery_address), '') is null
     or new.delivery_address !~* '\mVilliers\M' then
    raise exception 'VILLIERS_DELIVERY_ADDRESS_REQUIRED' using errcode = '22023';
  end if;

  v_messaging_conversation_id := nullif(
    new.draft_snapshot->>'messaging_conversation_id',
    ''
  )::uuid;
  if v_messaging_conversation_id is not null then
    select c.mode into v_conversation_mode
    from public.messaging_conversations c
    where c.id = v_messaging_conversation_id;

    if v_conversation_mode is distinct from 'automation' then
      raise exception 'DRY_RUN_ORDER_SUBMISSION_BLOCKED' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function private.getit_is_within_villiers_delivery_radius(numeric, numeric)
  from public, anon, authenticated;
revoke all on function private.enforce_getit_order_delivery_geofence()
  from public, anon, authenticated;

drop trigger if exists getit_orders_villiers_delivery_geofence on public.orders;
create trigger getit_orders_villiers_delivery_geofence
before insert or update of source_channel, delivery_address, delivery_latitude, delivery_longitude
on public.orders
for each row
execute function private.enforce_getit_order_delivery_geofence();

commit;
