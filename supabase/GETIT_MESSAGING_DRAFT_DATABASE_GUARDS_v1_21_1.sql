begin;

-- Enforce the launch rules below the AI/orchestration layer. Even a future
-- worker bug or direct service call cannot persist an oversized or out-of-area
-- messaging draft.
create or replace function private.enforce_getit_messaging_draft_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_orders jsonb;
  v_order jsonb;
  v_items jsonb;
  v_item jsonb;
  v_quantity numeric;
  v_units integer;
  v_shop_count integer;
  v_latitude numeric;
  v_longitude numeric;
  v_address text;
begin
  if new.state is null or jsonb_typeof(new.state) <> 'object' then
    raise exception 'DRAFT_STATE_INVALID' using errcode = '22023';
  end if;

  v_orders := coalesce(new.state->'orders', '[]'::jsonb);
  if jsonb_typeof(v_orders) <> 'array' or jsonb_array_length(v_orders) > 5 then
    raise exception 'DRAFT_ORDER_COUNT_INVALID' using errcode = '22023';
  end if;

  for v_order in select value from jsonb_array_elements(v_orders)
  loop
    v_items := coalesce(v_order->'items', '[]'::jsonb);
    if jsonb_typeof(v_items) <> 'array' then
      raise exception 'DRAFT_ITEMS_INVALID' using errcode = '22023';
    end if;
    if jsonb_array_length(v_items) > 16 then
      raise exception 'ITEM_LINE_LIMIT_EXCEEDED' using errcode = '22023';
    end if;

    v_units := 0;
    for v_item in select value from jsonb_array_elements(v_items)
    loop
      v_quantity := coalesce(nullif(v_item->>'quantity', '')::numeric, 1);
      if nullif(btrim(v_item->>'requested_text'), '') is null
         or v_quantity < 1
         or v_quantity <> trunc(v_quantity) then
        raise exception 'DRAFT_ITEM_INVALID' using errcode = '22023';
      end if;
      v_units := v_units + v_quantity::integer;
    end loop;
    if v_units > 24 then
      raise exception 'UNIT_LIMIT_EXCEEDED' using errcode = '22023';
    end if;

    select count(distinct shop_name)::integer
    into v_shop_count
    from (
      select nullif(btrim(value), '') as shop_name
      from jsonb_array_elements_text(coalesce(v_order->'shop_names', '[]'::jsonb))
      union all
      select nullif(btrim(item->>'requested_shop_name'), '') as shop_name
      from jsonb_array_elements(v_items) as i(item)
    ) shops
    where shop_name is not null;
    if coalesce(v_shop_count, 0) > 3 then
      raise exception 'SHOP_LIMIT_EXCEEDED' using errcode = '22023';
    end if;

    v_address := nullif(btrim(v_order->>'delivery_address'), '');
    v_latitude := nullif(v_order#>>'{delivery_location,latitude}', '')::numeric;
    v_longitude := nullif(v_order#>>'{delivery_location,longitude}', '')::numeric;

    if v_address is not null and v_address !~* '\mVilliers\M' then
      raise exception 'VILLIERS_DELIVERY_ADDRESS_REQUIRED' using errcode = '22023';
    end if;
    if (v_latitude is null) <> (v_longitude is null) then
      raise exception 'LOCATION_COORDINATES_INCOMPLETE' using errcode = '22023';
    end if;
    if v_latitude is not null
       and not private.getit_is_within_villiers_delivery_radius(
         v_latitude,
         v_longitude
       ) then
      raise exception 'LOCATION_OUTSIDE_VILLIERS' using errcode = '22023';
    end if;
  end loop;

  return new;
end;
$function$;

revoke all on function private.enforce_getit_messaging_draft_limits()
  from public, anon, authenticated;

drop trigger if exists getit_messaging_draft_limits on public.messaging_order_drafts;
create trigger getit_messaging_draft_limits
before insert or update of state
on public.messaging_order_drafts
for each row
execute function private.enforce_getit_messaging_draft_limits();

commit;
