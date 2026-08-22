-- Run against GETIT-CORE as postgres/service administration only.
-- Each expected failure is contained in a PL/pgSQL subtransaction, so the
-- script leaves no test conversation or draft behind.

do $test$
declare
  v_conversation uuid;
  v_items jsonb;
begin
  -- A seventeenth item line must fail at the database boundary.
  begin
    v_conversation := public.upsert_messaging_conversation(
      'meta_whatsapp', 'whatsapp', '+27829990101',
      'getit-draft-guard-lines', null, 'dry_run'
    );
    select jsonb_agg(jsonb_build_object(
      'requested_text', 'Test item ' || n::text,
      'quantity', 1
    ) order by n)
    into v_items
    from generate_series(1, 17) n;

    insert into public.messaging_order_drafts(conversation_id, state)
    values (v_conversation, jsonb_build_object(
      'stage', 'collecting',
      'orders', jsonb_build_array(jsonb_build_object('items', v_items))
    ));
    raise exception 'SEVENTEENTH_ITEM_LINE_WAS_ACCEPTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'ITEM_LINE_LIMIT_EXCEEDED' then raise; end if;
  end;

  -- More than 24 physical units must fail even with fewer than 16 lines.
  begin
    v_conversation := public.upsert_messaging_conversation(
      'meta_whatsapp', 'whatsapp', '+27829990102',
      'getit-draft-guard-units', null, 'dry_run'
    );
    insert into public.messaging_order_drafts(conversation_id, state)
    values (v_conversation, jsonb_build_object(
      'stage', 'collecting',
      'orders', jsonb_build_array(jsonb_build_object(
        'items', jsonb_build_array(
          jsonb_build_object('requested_text', 'Test milk', 'quantity', 25)
        )
      ))
    ));
    raise exception 'TWENTY_FIFTH_UNIT_WAS_ACCEPTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'UNIT_LIMIT_EXCEEDED' then raise; end if;
  end;

  -- Four shops must fail before an invalid fee can be persisted.
  begin
    v_conversation := public.upsert_messaging_conversation(
      'meta_whatsapp', 'whatsapp', '+27829990103',
      'getit-draft-guard-shops', null, 'dry_run'
    );
    insert into public.messaging_order_drafts(conversation_id, state)
    values (v_conversation, jsonb_build_object(
      'stage', 'collecting',
      'orders', jsonb_build_array(jsonb_build_object(
        'items', jsonb_build_array(
          jsonb_build_object('requested_text', 'Test milk', 'quantity', 1)
        ),
        'shop_names', jsonb_build_array('Shop A', 'Shop B', 'Shop C', 'Shop D')
      ))
    ));
    raise exception 'FOURTH_SHOP_WAS_ACCEPTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'SHOP_LIMIT_EXCEEDED' then raise; end if;
  end;

  -- A Cape Town pin must never become a deliverable draft.
  begin
    v_conversation := public.upsert_messaging_conversation(
      'meta_whatsapp', 'whatsapp', '+27829990104',
      'getit-draft-guard-geofence', null, 'dry_run'
    );
    insert into public.messaging_order_drafts(conversation_id, state)
    values (v_conversation, jsonb_build_object(
      'stage', 'awaiting_confirmation',
      'orders', jsonb_build_array(jsonb_build_object(
        'items', jsonb_build_array(
          jsonb_build_object('requested_text', 'Test milk', 'quantity', 1)
        ),
        'delivery_location', jsonb_build_object(
          'latitude', -33.9249,
          'longitude', 18.4241
        )
      ))
    ));
    raise exception 'OUTSIDE_DRAFT_PIN_WAS_ACCEPTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'LOCATION_OUTSIDE_VILLIERS' then raise; end if;
  end;
end;
$test$;

select
  exists (
    select 1 from pg_trigger
    where tgname = 'getit_messaging_draft_limits' and tgenabled = 'O'
  ) as trigger_enabled,
  (
    select count(*)
    from public.messaging_conversations
    where external_conversation_key like 'getit-draft-guard-%'
  ) as residual_test_conversations;
