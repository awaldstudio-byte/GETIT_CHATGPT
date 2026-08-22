-- Permanent pre-launch cleanup for Getit production.
-- Keeps the live catalogue, shops, drivers, staff, and the real Nathan/Bella
-- customer identities. Messaging histories are cleared so those two contacts
-- begin with fresh conversations while retaining their current automation mode.

do $cleanup$
declare
  v_unfinished_inbox integer;
  v_unfinished_outbox integer;
  v_unexpected_orders integer;
begin
  select count(*) into v_unfinished_inbox
  from private.messaging_inbox_events
  where status = 'processing';

  select count(*) into v_unfinished_outbox
  from private.messaging_outbox
  where status = 'processing';

  if v_unfinished_inbox <> 0 or v_unfinished_outbox <> 0 then
    raise exception 'pre-launch cleanup refused while messaging work is processing';
  end if;

  select count(*) into v_unexpected_orders
  from public.orders
  where not (
    order_number like 'TST-%'
    or (
      order_number in ('GET-1007', 'GET-1010')
      and created_at < timestamptz '2026-08-01 00:00:00+00'
    )
  );

  if v_unexpected_orders <> 0 then
    raise exception 'pre-launch cleanup refused because a non-test order now exists';
  end if;

  -- Remove the withdrawn malformed WhatsApp shop-form test and its receipts.
  delete from private.partner_application_message_receipts r
  using public.partner_applications a
  where r.application_id = a.id
    and a.status = 'withdrawn'
    and a.created_at < timestamptz '2026-08-12 00:00:00+00';

  delete from public.partner_applications
  where status = 'withdrawn'
    and created_at < timestamptz '2026-08-12 00:00:00+00';

  -- Retired Chatwoot/Respond.io state is historical test material only.
  delete from private.messaging_chatwoot_mirror_outbox
  where status <> 'processing';

  delete from public.messaging_chatwoot_links;
  delete from public.respond_contact_locations;

  -- Clear final messaging ledger rows, while preserving anything newly queued
  -- by Meta while the worker is stopped.
  delete from private.messaging_outbox
  where status <> 'processing'
    and status <> 'pending';

  delete from private.messaging_inbox_events
  where status <> 'processing'
    and status <> 'pending';

  -- Clear the three pre-launch conversation histories and all derived state.
  delete from public.messaging_handoff_events;
  delete from public.messaging_incidents;
  delete from public.messaging_operator_reads;
  delete from public.messaging_order_drafts;
  delete from private.partner_application_message_receipts;
  delete from public.messaging_messages;

  -- Delete the Meta sandbox test contact, but retain real customer identities.
  delete from public.messaging_conversations c
  using public.customers customer
  where c.customer_id = customer.id
    and regexp_replace(coalesce(customer.phone, ''), '[^0-9]', '', 'g') = '16315551181';

  delete from public.customers
  where regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = '16315551181';

  -- Keep Nathan and Bella as empty, fresh conversations, preserving each mode.
  update public.messaging_conversations c
  set status = 'open',
      assigned_staff_user_id = null,
      last_inbound_at = null,
      last_outbound_at = null,
      last_message_at = null,
      version = c.version + 1,
      updated_at = now()
  from public.customers customer
  where c.customer_id = customer.id
    and regexp_replace(coalesce(customer.phone, ''), '[^0-9]', '', 'g')
        in ('27840593458', '27651039577');

  update public.customers
  set notes = 'Created or linked by the provider-neutral Getit messaging pipeline.',
      updated_at = now()
  where regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
        in ('27840593458', '27651039577');

  -- All current orders and runs are the verified pre-launch fixtures.
  delete from public.orders
  where order_number like 'TST-%'
     or (
       order_number in ('GET-1007', 'GET-1010')
       and created_at < timestamptz '2026-08-01 00:00:00+00'
     );

  delete from public.delivery_runs
  where created_at < timestamptz '2026-08-01 00:00:00+00';

  delete from public.automation_events
  where created_at < timestamptz '2026-08-01 00:00:00+00';

  -- Remove generated catalogue-demo customers after their orders are gone.
  delete from public.customers customer
  where (
      customer.full_name like '% • TEST'
      or customer.full_name like '% Mock Customer'
    )
    and not exists (select 1 from public.orders o where o.customer_id = customer.id)
    and not exists (select 1 from public.messaging_conversations c where c.customer_id = customer.id);
end;
$cleanup$;
