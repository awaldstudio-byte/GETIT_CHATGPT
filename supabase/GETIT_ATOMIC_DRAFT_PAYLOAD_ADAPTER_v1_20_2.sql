-- Translate the dashboard/WhatsApp draft shape into the provider-neutral order
-- intake shape inside the same transaction as customer confirmation.

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
  v_state jsonb;
  v_orders jsonb;
  v_order jsonb;
  v_items jsonb;
  v_payload jsonb;
  v_results jsonb := '[]'::jsonb;
  v_result record;
  v_count integer;
  v_index integer := 0;
  v_shop_count integer;
  v_address text;
  v_latitude text;
  v_longitude text;
begin
  perform private.assert_messaging_service_role();

  v_confirmed := public.confirm_messaging_order_draft_v2(
    p_conversation_id,
    p_expected_version,
    p_confirmation_message_id
  );

  v_state := v_confirmed.state;
  v_orders := coalesce(v_state->'orders', '[]'::jsonb);
  v_count := jsonb_array_length(v_orders);
  if v_count < 1 or v_count > 5 then
    raise exception 'confirmed draft order count invalid' using errcode = '22023';
  end if;

  for v_order in select value from jsonb_array_elements(v_orders)
  loop
    v_index := v_index + 1;

    select coalesce(jsonb_agg(
      item || case
        when nullif(btrim(item->>'requested_shop_name'), '') is not null
          then jsonb_build_object('requested_shop', btrim(item->>'requested_shop_name'))
        else '{}'::jsonb
      end
      order by ordinality
    ), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(coalesce(v_order->'items', '[]'::jsonb)) with ordinality as e(item, ordinality);

    select count(distinct shop_name)::integer
    into v_shop_count
    from (
      select nullif(btrim(value), '') as shop_name
      from jsonb_array_elements_text(coalesce(v_order->'shop_names', '[]'::jsonb))
      union all
      select nullif(btrim(item->>'requested_shop_name'), '') as shop_name
      from jsonb_array_elements(coalesce(v_order->'items', '[]'::jsonb)) as i(item)
    ) shops
    where shop_name is not null;
    v_shop_count := greatest(1, coalesce(v_shop_count, 0));

    v_latitude := nullif(v_order#>>'{delivery_location,latitude}', '');
    v_longitude := nullif(v_order#>>'{delivery_location,longitude}', '');
    v_address := nullif(btrim(v_order->>'delivery_address'), '');
    if v_address is null and v_latitude is not null and v_longitude is not null then
      v_address := 'WhatsApp location pin, Villiers';
    end if;

    v_payload := (v_state - 'stage' - 'orders')
      || (v_order - 'items' - 'shop_names' - 'delivery_location')
      || jsonb_build_object(
        'items', v_items,
        'shop_count', v_shop_count,
        'delivery_area', 'Villiers',
        'delivery_address', v_address,
        'delivery_latitude', v_latitude,
        'delivery_longitude', v_longitude,
        'location_status', 'LOCATION CONFIRMED',
        'location_source', case when v_latitude is not null then 'order_specific_pin' else 'typed_address' end,
        'draft_confirmation', 'CONFIRMED',
        'draft_summary', coalesce(nullif(btrim(v_order->>'draft_summary'), ''), 'Confirmed Getit order')
      );

    for v_result in
      select * from public.submit_getit_messaging_order_v2(p_conversation_id, v_payload)
    loop
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'order_index', v_index,
        'order_label', coalesce(nullif(v_order->>'label', ''), 'Order ' || v_index::text),
        'order_id', v_result.order_id,
        'order_number', v_result.order_number,
        'order_status', v_result.order_status,
        'payment_review_status', v_result.payment_review_status,
        'duplicate', v_result.duplicate,
        'created_at', v_result.created_at
      ));
    end loop;
  end loop;

  if jsonb_array_length(v_results) <> v_count then
    raise exception 'order submission returned an unexpected number of orders' using errcode = 'P0001';
  end if;

  update public.messaging_order_drafts
  set state = jsonb_set(
        jsonb_set(v_state, '{stage}', '"waiting_review"'::jsonb, true),
        '{last_submission}',
        jsonb_build_object('submitted_at', now(), 'orders', v_results),
        true
      ),
      version = version + 1,
      updated_at = now()
  where conversation_id = p_conversation_id
    and version = v_confirmed.version;
  if not found then
    raise exception 'draft state changed during submission' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'submitted', true,
    'orders', v_results,
    'draft_version', v_confirmed.version + 1
  );
end;
$function$;

revoke all on function public.confirm_and_submit_messaging_order_draft_v1(uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.confirm_and_submit_messaging_order_draft_v1(uuid, bigint, bigint) to service_role;
