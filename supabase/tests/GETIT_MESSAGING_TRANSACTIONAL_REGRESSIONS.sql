-- Run against GETIT-CORE as postgres/service administration only.
-- Both mutation blocks deliberately roll themselves back; a successful run
-- leaves no conversations, customers, orders, items or payment reviews.

do $test$
declare
  v_conversation uuid;
  v_first record;
  v_second record;
  v_fee numeric;
  v_order_count integer;
  v_review_count integer;
  v_match_count integer;
begin
  -- Specific real-catalogue requests may be linked for staff review, but an
  -- ambiguous request without a shop must remain unlinked.
  select count(*) into v_match_count
  from private.resolve_messaging_catalogue_item_v1(
    'KOO Baked Beans 400g',
    'OK Villiers'
  ) match
  join public.products product on product.id = match.product_id
  where product.brand = 'KOO'
    and product.size = '400 g'
    and match.shop_name = 'OK Villiers';
  if v_match_count <> 1 then
    raise exception 'SPECIFIC_CATALOGUE_MATCH_ASSERTION_FAILED';
  end if;

  select count(*) into v_match_count
  from private.resolve_messaging_catalogue_item_v1('baked beans', null);
  if v_match_count <> 0 then
    raise exception 'AMBIGUOUS_CATALOGUE_MATCH_WAS_LINKED';
  end if;

  -- A geographically invalid pin must be rejected by the database even if an
  -- alternate workflow claims the delivery area is Villiers.
  begin
    v_conversation := public.upsert_messaging_conversation(
      'meta_whatsapp', 'whatsapp', '+27829990001',
      'getit-geofence-negative', null, 'automation'
    );
    perform *
    from public.submit_getit_messaging_order_v2(
      v_conversation,
      jsonb_build_object(
        'draft_confirmation', 'CONFIRMED',
        'items', jsonb_build_array(
          jsonb_build_object('requested_text', 'Milk', 'quantity', 1)
        ),
        'delivery_area', 'Villiers',
        'delivery_address', 'WhatsApp location pin, Villiers',
        'delivery_latitude', -33.9249,
        'delivery_longitude', 18.4241,
        'location_status', 'LOCATION CONFIRMED',
        'shop_count', 1,
        'draft_summary', '1 x Milk'
      )
    );
    raise exception 'OUTSIDE_PIN_WAS_ACCEPTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'LOCATION_OUTSIDE_VILLIERS' then
        raise;
      end if;
  end;

  -- The database must also enforce dry-run. A misconfigured worker cannot
  -- turn a draft into a real order merely by calling the submission RPC.
  begin
    v_conversation := public.upsert_messaging_conversation(
      'meta_whatsapp', 'whatsapp', '+27829990003',
      'getit-dry-run-negative', null, 'dry_run'
    );
    perform *
    from public.submit_getit_messaging_order_v2(
      v_conversation,
      jsonb_build_object(
        'draft_confirmation', 'CONFIRMED',
        'items', jsonb_build_array(
          jsonb_build_object('requested_text', 'Milk', 'quantity', 1)
        ),
        'delivery_area', 'Villiers',
        'delivery_address', 'WhatsApp location pin, Villiers',
        'delivery_latitude', -27.029719,
        'delivery_longitude', 28.600826,
        'location_status', 'LOCATION CONFIRMED',
        'shop_count', 1,
        'draft_summary', '1 x Milk'
      )
    );
    raise exception 'DRY_RUN_ORDER_WAS_CREATED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'DRY_RUN_ORDER_SUBMISSION_BLOCKED' then
        raise;
      end if;
  end;

  -- A valid Villiers order must calculate the 17-24 unit fee, create one
  -- review, and return the original order on an identical retry.
  begin
    v_conversation := public.upsert_messaging_conversation(
      'meta_whatsapp', 'whatsapp', '+27829990002',
      'getit-geofence-positive', null, 'automation'
    );

    select * into v_first
    from public.submit_getit_messaging_order_v2(
      v_conversation,
      jsonb_build_object(
        'draft_confirmation', 'CONFIRMED',
        'items', jsonb_build_array(
          jsonb_build_object('requested_text', 'Milk', 'quantity', 17)
        ),
        'delivery_area', 'Villiers',
        'delivery_address', 'WhatsApp location pin, Villiers',
        'delivery_latitude', -27.029719,
        'delivery_longitude', 28.600826,
        'location_status', 'LOCATION CONFIRMED',
        'shop_count', 1,
        'draft_summary', '17 x Milk'
      )
    );

    select * into v_second
    from public.submit_getit_messaging_order_v2(
      v_conversation,
      jsonb_build_object(
        'draft_confirmation', 'CONFIRMED',
        'items', jsonb_build_array(
          jsonb_build_object('requested_text', 'Milk', 'quantity', 17)
        ),
        'delivery_area', 'Villiers',
        'delivery_address', 'WhatsApp location pin, Villiers',
        'delivery_latitude', -27.029719,
        'delivery_longitude', 28.600826,
        'location_status', 'LOCATION CONFIRMED',
        'shop_count', 1,
        'draft_summary', '17 x Milk'
      )
    );

    select delivery_fee into v_fee
    from public.orders
    where id = v_first.order_id;

    select count(*) into v_order_count
    from public.orders
    where submission_fingerprint = (
      select submission_fingerprint
      from public.orders
      where id = v_first.order_id
    );

    select count(*) into v_review_count
    from public.payment_reviews
    where order_id = v_first.order_id;

    if v_first.duplicate
       or not v_second.duplicate
       or v_first.order_id <> v_second.order_id then
      raise exception 'IDEMPOTENCY_ASSERTION_FAILED';
    end if;
    if v_fee <> 50 or v_order_count <> 1 or v_review_count <> 1 then
      raise exception 'ORDER_FEE_OR_REVIEW_ASSERTION_FAILED';
    end if;

    raise exception 'GETIT_VALID_TEST_ROLLBACK';
  exception
    when raise_exception then
      if sqlerrm <> 'GETIT_VALID_TEST_ROLLBACK' then
        raise;
      end if;
  end;
end;
$test$;

select
  private.getit_is_within_villiers_delivery_radius(-27.029719, 28.600826)
    as villiers_allowed,
  private.getit_is_within_villiers_delivery_radius(-27.0233364, 28.6255542)
    as qalabotjha_allowed,
  private.getit_is_within_villiers_delivery_radius(-33.9249, 18.4241)
    as cape_town_rejected,
  exists (
    select 1
    from pg_trigger
    where tgname = 'getit_orders_villiers_delivery_geofence'
      and tgenabled = 'O'
  ) as trigger_enabled,
  (
    select count(*)
    from public.messaging_conversations
    where external_conversation_key in (
      'getit-geofence-negative',
      'getit-geofence-positive',
      'getit-dry-run-negative'
    )
  ) as residual_test_conversations;
