-- =========================================================
-- GETIT CONTROL CENTRE v1.6 — FRONTEND + OPERATIONS HARDENING
-- Run AFTER Getit_v1_5_DYNAMIC_OPERATIONS_upgrade.sql
--
-- Fixes discovered while wiring the real Control Centre:
--   • payment reviews no longer reset themselves after approval
--   • existing generated/sent payment links are preserved
--   • every manual-driver option appears once with a clear reason
--   • reassignments do not double-count the order in driver capacity
--   • empty dynamic runs are automatically removed
--   • webhook/driver RPCs are explicitly protected
--   • exact shop pins can be corrected and verified
--   • dashboard-ready order and payment views
-- =========================================================

-- ---------------------------------------------------------
-- VIEW SECURITY
-- Existing views are only useful to authenticated operations staff, and
-- must honour the RLS rules on their underlying tables.
-- ---------------------------------------------------------

alter view if exists public.driver_effective_status set (security_invoker = true);
alter view if exists public.driver_control_board set (security_invoker = true);
alter view if exists public.order_review_lines set (security_invoker = true);
alter view if exists public.payment_review_queue set (security_invoker = true);
alter view if exists public.map_order_pins set (security_invoker = true);
alter view if exists public.map_shop_pins set (security_invoker = true);

-- ---------------------------------------------------------
-- PAYMENT REVIEW STATE FIX
-- Routine order-status changes must never turn a link_requested/link_ready/
-- link_sent review back into pending_review. Item content changes do reset it.
-- ---------------------------------------------------------

create or replace function public.ensure_payment_review_pending(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_number text;
  v_existing_status text;
begin
  select order_number into v_order_number
  from public.orders
  where id = p_order_id;

  if not found then return; end if;

  select status into v_existing_status
  from public.payment_reviews
  where order_id = p_order_id;

  insert into public.payment_reviews (order_id, status, requested_at)
  values (p_order_id, 'pending_review', now())
  on conflict (order_id) do update
  set
    status = case
      when public.payment_reviews.status in (
        'approved', 'link_requested', 'link_ready', 'link_sent', 'paid'
      ) then public.payment_reviews.status
      else 'pending_review'
    end,
    requested_at = case
      when public.payment_reviews.status in (
        'approved', 'link_requested', 'link_ready', 'link_sent', 'paid'
      ) then public.payment_reviews.requested_at
      else least(public.payment_reviews.requested_at, now())
    end;

  if coalesce(v_existing_status, 'pending_review') not in (
      'approved', 'link_requested', 'link_ready', 'link_sent', 'paid'
    )
    and not exists (
      select 1
      from public.automation_events ae
      where ae.order_id = p_order_id
        and ae.event_type = 'payment_review_waiting'
        and ae.status in ('pending', 'processing')
    ) then
    insert into public.automation_events (event_type, order_id, payload)
    values (
      'payment_review_waiting',
      p_order_id,
      jsonb_build_object(
        'order_number', v_order_number,
        'customer_message', 'Thanks — your order is being checked. Please wait while we generate your secure payment link.'
      )
    );
  end if;
end;
$$;

create or replace function public.reset_payment_review_for_item_change(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment_status text;
  v_order_number text;
begin
  select payment_status, order_number
  into v_payment_status, v_order_number
  from public.orders
  where id = p_order_id;

  if not found then return; end if;

  if v_payment_status = 'paid' then
    if not exists (
      select 1 from public.support_queries
      where order_id = p_order_id
        and status = 'open'
        and issue_type = 'payment'
        and issue_summary = 'A paid order was changed after payment'
    ) then
      insert into public.support_queries (
        order_id, issue_type, issue_summary, opened_by, details
      ) values (
        p_order_id,
        'payment',
        'A paid order was changed after payment',
        'system',
        jsonb_build_object('order_number', v_order_number)
      );
    end if;
    return;
  end if;

  insert into public.payment_reviews (order_id, status, requested_at)
  values (p_order_id, 'pending_review', now())
  on conflict (order_id) do update
  set
    status = 'pending_review',
    approved_goods_total = null,
    approved_order_total = null,
    payment_link = null,
    provider_reference = null,
    approved_at = null,
    approved_by = null,
    link_ready_at = null,
    link_sent_at = null,
    paid_at = null,
    requested_at = now();

  update public.automation_events
  set status = 'cancelled', updated_at = now()
  where order_id = p_order_id
    and event_type in ('payment_link_requested', 'payment_link_ready')
    and status in ('pending', 'processing');

  insert into public.automation_events (event_type, order_id, payload)
  values (
    'payment_review_waiting',
    p_order_id,
    jsonb_build_object(
      'order_number', v_order_number,
      'customer_message', 'Your order changed, so we are checking the updated amount before sending the secure payment link.'
    )
  );
end;
$$;

create or replace function public.payment_review_item_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_content jsonb;
  v_new_content jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reset_payment_review_for_item_change(old.order_id);
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.reset_payment_review_for_item_change(new.order_id);
    return new;
  end if;

  -- Review-only fields change while Mum checks a price. Those updates must
  -- not invalidate the payment review she is currently completing.
  v_old_content := to_jsonb(old)
    - 'review_unit_price'
    - 'price_verified'
    - 'review_note'
    - 'reviewed_at'
    - 'reviewed_by'
    - 'updated_at';
  v_new_content := to_jsonb(new)
    - 'review_unit_price'
    - 'price_verified'
    - 'review_note'
    - 'reviewed_at'
    - 'reviewed_by'
    - 'updated_at';

  if v_new_content is distinct from v_old_content then
    perform public.reset_payment_review_for_item_change(new.order_id);
  end if;

  return new;
end;
$$;

-- Recreate the trigger with the corrected comparison logic.
drop trigger if exists ensure_payment_review_on_item on public.order_items;
create trigger ensure_payment_review_on_item
after insert or update or delete
on public.order_items
for each row execute function public.payment_review_item_trigger();

-- Save every reviewed item and request the payment link in one database
-- transaction. This prevents one network round-trip and dashboard refresh per
-- line item when the dispatcher approves a full order.
create or replace function public.approve_payment_review_with_prices(
  p_order_id uuid,
  p_items jsonb,
  p_review_note text default null
)
returns table (
  payment_review_id uuid,
  approved_goods_total numeric,
  approved_order_total numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_item_id uuid;
  v_price numeric;
  v_note text;
  v_expected_count integer;
  v_received_count integer;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to approve payment reviews';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Reviewed items must be supplied as a JSON array';
  end if;

  perform 1
  from public.orders
  where id = p_order_id
  for update;

  if not found then raise exception 'Order not found'; end if;

  perform id
  from public.order_items
  where order_id = p_order_id
  for update;

  if exists (
    select 1 from public.payment_reviews
    where order_id = p_order_id
      and status in ('link_requested', 'link_ready', 'link_sent', 'paid')
  ) then
    raise exception 'A payment link has already been requested or completed for this order';
  end if;

  select count(*) into v_expected_count
  from public.order_items
  where order_id = p_order_id;

  select count(*) into v_received_count
  from jsonb_array_elements(p_items) as received(item);

  if v_expected_count = 0 then
    raise exception 'The order has no item lines to approve';
  end if;

  if v_received_count <> v_expected_count then
    raise exception 'Every order item must be included exactly once';
  end if;

  if exists (
    select 1
    from (
      select (item ->> 'order_item_id')::uuid as order_item_id, count(*) as occurrences
      from jsonb_array_elements(p_items) as entries(item)
      group by (item ->> 'order_item_id')::uuid
    ) duplicates
    where duplicates.occurrences <> 1
  ) then
    raise exception 'Each order item must be included exactly once';
  end if;

  for v_item in
    select item from jsonb_array_elements(p_items) as entries(item)
  loop
    begin
      v_item_id := (v_item ->> 'order_item_id')::uuid;
      v_price := (v_item ->> 'unit_price')::numeric;
      v_note := nullif(btrim(v_item ->> 'note'), '');
    exception when others then
      raise exception 'One or more reviewed item values are invalid';
    end;

    if v_price is null or v_price < 0 then
      raise exception 'Every unit price must be zero or greater';
    end if;

    update public.order_items
    set
      review_unit_price = round(v_price, 2),
      price_verified = true,
      review_note = v_note,
      reviewed_at = now(),
      reviewed_by = auth.uid()
    where id = v_item_id
      and order_id = p_order_id;

    if not found then
      raise exception 'An item does not belong to this order';
    end if;
  end loop;

  return query
  select result.payment_review_id,
         result.approved_goods_total,
         result.approved_order_total
  from public.approve_payment_review(p_order_id, p_review_note) result;
end;
$$;

-- Synchronise approved totals to the main order record when those historical
-- columns exist. Dynamic SQL keeps this patch compatible with earlier schemas.
create or replace function public.sync_approved_order_totals(
  p_order_id uuid,
  p_goods_total numeric,
  p_order_total numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'goods_total'
  ) then
    execute 'update public.orders set goods_total = $1 where id = $2'
    using round(p_goods_total, 2), p_order_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'order_total'
  ) then
    execute 'update public.orders set order_total = $1 where id = $2'
    using round(p_order_total, 2), p_order_id;
  end if;
end;
$$;

-- The v1.5 approval function already validates and queues the event. Add a
-- trigger that keeps the main order total in sync after approval without
-- changing the public RPC signature.
create or replace function public.sync_payment_review_to_order_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('approved', 'link_requested', 'link_ready', 'link_sent', 'paid')
     and new.approved_goods_total is not null
     and new.approved_order_total is not null then
    perform public.sync_approved_order_totals(
      new.order_id,
      new.approved_goods_total,
      new.approved_order_total
    );
  end if;
  return new;
end;
$$;

drop trigger if exists sync_payment_review_to_order on public.payment_reviews;
create trigger sync_payment_review_to_order
after insert or update of status, approved_goods_total, approved_order_total
on public.payment_reviews
for each row execute function public.sync_payment_review_to_order_trigger();

-- Add the fee breakdown expected by the payment-review screen while keeping
-- every existing payment_review_queue column in the same order.
create or replace view public.payment_review_queue
with (security_invoker = true)
as
select
  pr.id as payment_review_id,
  pr.order_id,
  o.order_number,
  pr.status,
  pr.requested_at,
  extract(epoch from (now() - pr.requested_at))::integer as waiting_seconds,
  coalesce(
    nullif(to_jsonb(c) ->> 'name', ''),
    nullif(to_jsonb(c) ->> 'full_name', ''),
    'Customer'
  ) as customer_name,
  o.delivery_address,
  o.goods_total as current_goods_total,
  pr.approved_goods_total,
  pr.approved_order_total,
  pr.payment_link,
  pr.review_note,
  count(orl.order_item_id)::integer as item_lines,
  bool_and(coalesce(orl.price_verified, false)) as all_prices_verified,
  coalesce(sum(orl.review_line_total), 0)::numeric(12,2) as reviewed_goods_total,
  coalesce(nullif(to_jsonb(o) ->> 'delivery_fee', '')::numeric, 0)::numeric(12,2) as delivery_fee,
  coalesce(nullif(to_jsonb(o) ->> 'second_shop_fee', '')::numeric, 0)::numeric(12,2) as second_shop_fee,
  coalesce(nullif(to_jsonb(o) ->> 'priority_fee', '')::numeric, 0)::numeric(12,2) as priority_fee,
  coalesce(nullif(to_jsonb(o) ->> 'order_total', '')::numeric, pr.approved_order_total, 0)::numeric(12,2) as current_order_total
from public.payment_reviews pr
join public.orders o on o.id = pr.order_id
left join public.customers c on c.id = o.customer_id
left join public.order_review_lines orl on orl.order_id = o.id
group by
  pr.id,
  pr.order_id,
  o.id,
  o.order_number,
  pr.status,
  pr.requested_at,
  c.id,
  o.delivery_address,
  o.goods_total,
  pr.approved_goods_total,
  pr.approved_order_total,
  pr.payment_link,
  pr.review_note;

-- ---------------------------------------------------------
-- MANUAL DRIVER OPTIONS — ONE DRIVER, ONE EXPLANATION
-- ---------------------------------------------------------

create or replace function public.manual_driver_options(p_order_id uuid)
returns table (
  driver_id uuid,
  driver_name text,
  effective_status text,
  logged_in boolean,
  services_order_zone boolean,
  current_run_id uuid,
  current_order_count integer,
  maximum_orders integer,
  used_weight_kg numeric,
  max_weight_kg numeric,
  used_space_units integer,
  max_space_units integer,
  can_assign boolean,
  unavailable_reason text
)
language sql
security definer
set search_path = public
as $$
  with target_order as (
    select
      id,
      delivery_zone_id,
      coalesce(estimated_weight_kg, 0)::numeric as estimated_weight_kg,
      coalesce(estimated_space_units, 0)::integer as estimated_space_units
    from public.orders
    where id = p_order_id
  )
  select
    d.id as driver_id,
    des.driver_name,
    des.effective_status,
    des.logged_in,
    exists (
      select 1
      from public.driver_zones dz
      join target_order t on t.delivery_zone_id = dz.zone_id
      where dz.driver_id = d.id
    ) as services_order_zone,
    current_run.run_id as current_run_id,
    coalesce(current_run.order_count, 0)::integer as current_order_count,
    d.maximum_orders,
    coalesce(current_run.used_weight, 0)::numeric as used_weight_kg,
    d.max_weight_kg,
    coalesce(current_run.used_space, 0)::integer as used_space_units,
    d.max_space_units,
    (
      d.active
      and des.effective_status = 'available'
      and exists (
        select 1
        from public.driver_zones dz
        join target_order t on t.delivery_zone_id = dz.zone_id
        where dz.driver_id = d.id
      )
      and not exists (
        select 1
        from public.delivery_runs blocked
        where blocked.driver_id = d.id
          and blocked.status in ('full', 'active')
      )
      and coalesce(current_run.order_count, 0) + 1 <= d.maximum_orders
      and coalesce(current_run.used_weight, 0) + (select estimated_weight_kg from target_order) <= d.max_weight_kg
      and coalesce(current_run.used_space, 0) + (select estimated_space_units from target_order) <= d.max_space_units
    ) as can_assign,
    case
      when not exists (select 1 from target_order) then 'Order was not found'
      when not d.active then 'Driver is inactive'
      when des.effective_status = 'offline' then 'Driver is not logged in'
      when des.effective_status = 'break' then 'Driver is on an approved break'
      when des.effective_status = 'break_requested' then 'Driver requested a break'
      when des.effective_status = 'unavailable' then 'Driver is marked unavailable'
      when des.effective_status = 'busy' then 'Driver is busy'
      when des.effective_status = 'ready_to_depart' then 'Driver bucket is ready to depart'
      when des.effective_status = 'out_for_delivery' then 'Driver is out for delivery'
      when not exists (
        select 1
        from public.driver_zones dz
        join target_order t on t.delivery_zone_id = dz.zone_id
        where dz.driver_id = d.id
      ) then 'Driver is not assigned to this delivery zone'
      when exists (
        select 1 from public.delivery_runs blocked
        where blocked.driver_id = d.id
          and blocked.status in ('full', 'active')
      ) then 'Driver is finishing another run'
      when coalesce(current_run.order_count, 0) + 1 > d.maximum_orders then 'Maximum order count reached'
      when coalesce(current_run.used_weight, 0) + (select estimated_weight_kg from target_order) > d.max_weight_kg then 'Weight capacity would be exceeded'
      when coalesce(current_run.used_space, 0) + (select estimated_space_units from target_order) > d.max_space_units then 'Bucket space would be exceeded'
      else null
    end as unavailable_reason
  from public.drivers d
  join public.driver_effective_status des on des.driver_id = d.id
  left join lateral (
    select
      r.id as run_id,
      count(o.id) filter (where o.id is not null and o.id <> p_order_id)::integer as order_count,
      coalesce(sum(o.estimated_weight_kg) filter (where o.id <> p_order_id), 0)::numeric as used_weight,
      coalesce(sum(o.estimated_space_units) filter (where o.id <> p_order_id), 0)::integer as used_space
    from public.delivery_runs r
    left join public.orders o
      on o.delivery_run_id = r.id
     and o.status <> 'cancelled'
    where r.driver_id = d.id
      and r.status = 'open'
      and coalesce(r.window_expires_at, r.slot_end) > now()
    group by r.id, coalesce(r.window_started_at, r.slot_start)
    order by coalesce(r.window_started_at, r.slot_start) desc
    limit 1
  ) current_run on true
  where (select public.current_staff_role()) in ('owner', 'admin', 'dispatcher')
  order by
    case when des.effective_status = 'available' then 0 else 1 end,
    case when current_run.run_id is not null then 0 else 1 end,
    des.driver_name;
$$;

-- Remove an old driver window when the final order is moved away from it.
create or replace function public.cleanup_empty_dynamic_run_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_run_id uuid;
begin
  if tg_op = 'DELETE' then
    v_old_run_id := old.delivery_run_id;
  elsif new.delivery_run_id is distinct from old.delivery_run_id then
    v_old_run_id := old.delivery_run_id;
  else
    return new;
  end if;

  if v_old_run_id is not null then
    delete from public.delivery_runs r
    where r.id = v_old_run_id
      and r.dynamic_window = true
      and r.status = 'open'
      and not exists (
        select 1 from public.orders o
        where o.delivery_run_id = r.id
          and o.status <> 'cancelled'
      );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists cleanup_empty_dynamic_run on public.orders;
create trigger cleanup_empty_dynamic_run
after update of delivery_run_id or delete
on public.orders
for each row execute function public.cleanup_empty_dynamic_run_trigger();

-- ---------------------------------------------------------
-- DASHBOARD-READY ORDER VIEW
-- ---------------------------------------------------------

create or replace view public.control_centre_orders
with (security_invoker = true)
as
select
  o.id,
  o.order_number,
  o.created_at,
  o.status,
  o.payment_status,
  o.priority,
  o.human_help_required,
  o.support_issue,
  o.customer_id,
  coalesce(
    nullif(to_jsonb(c) ->> 'name', ''),
    nullif(to_jsonb(c) ->> 'full_name', ''),
    'Customer'
  ) as customer_name,
  coalesce(
    nullif(to_jsonb(c) ->> 'whatsapp_number', ''),
    nullif(to_jsonb(c) ->> 'phone', ''),
    nullif(to_jsonb(c) ->> 'phone_number', '')
  ) as customer_phone,
  o.delivery_zone_id,
  coalesce(nullif(to_jsonb(z) ->> 'name', ''), nullif(to_jsonb(z) ->> 'town', '')) as delivery_area,
  o.assigned_driver_id,
  coalesce(
    nullif(to_jsonb(d) ->> 'name', ''),
    nullif(to_jsonb(d) ->> 'full_name', ''),
    nullif(to_jsonb(d) ->> 'driver_name', '')
  ) as driver_name,
  o.delivery_run_id,
  o.stop_sequence,
  o.delivery_address,
  o.delivery_latitude,
  o.delivery_longitude,
  mop.location_quality,
  mop.google_maps_url,
  coalesce(nullif(to_jsonb(o) ->> 'goods_total', '')::numeric, 0)::numeric(12,2) as goods_total,
  coalesce(nullif(to_jsonb(o) ->> 'delivery_fee', '')::numeric, 0)::numeric(12,2) as delivery_fee,
  coalesce(nullif(to_jsonb(o) ->> 'second_shop_fee', '')::numeric, 0)::numeric(12,2) as second_shop_fee,
  coalesce(nullif(to_jsonb(o) ->> 'priority_fee', '')::numeric, 0)::numeric(12,2) as priority_fee,
  coalesce(
    nullif(to_jsonb(o) ->> 'order_total', '')::numeric,
    pr.approved_order_total,
    0
  )::numeric(12,2) as order_total,
  coalesce(nullif(to_jsonb(o) ->> 'estimated_weight_kg', '')::numeric, 0)::numeric as estimated_weight_kg,
  coalesce(nullif(to_jsonb(o) ->> 'estimated_space_units', '')::integer, 0)::integer as estimated_space_units,
  nullif(to_jsonb(o) ->> 'scheduled_at', '')::timestamptz as scheduled_at,
  nullif(to_jsonb(o) ->> 'scheduling_note', '') as scheduling_note,
  pr.status as payment_review_status,
  count(oi.id)::integer as item_lines
from public.orders o
left join public.customers c on c.id = o.customer_id
left join public.delivery_zones z on z.id = o.delivery_zone_id
left join public.drivers d on d.id = o.assigned_driver_id
left join public.payment_reviews pr on pr.order_id = o.id
left join public.map_order_pins mop on mop.order_id = o.id
left join public.order_items oi on oi.order_id = o.id
group by
  o.id,
  c.id,
  z.id,
  d.id,
  pr.id,
  mop.order_id,
  mop.location_quality,
  mop.google_maps_url;

grant select on public.control_centre_orders to authenticated;
grant select on public.payment_review_queue to authenticated;

-- ---------------------------------------------------------
-- ACCURATE SHOP + ORDER PINS
-- ---------------------------------------------------------

create or replace function public.save_shop_location(
  p_shop_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_verified boolean default true,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role'
     and (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to change shop locations';
  end if;

  if p_latitude is null or p_latitude < -90 or p_latitude > 90 then
    raise exception 'Latitude must be between -90 and 90';
  end if;

  if p_longitude is null or p_longitude < -180 or p_longitude > 180 then
    raise exception 'Longitude must be between -180 and 180';
  end if;

  update public.shops
  set
    latitude = round(p_latitude, 7),
    longitude = round(p_longitude, 7),
    coordinate_source = 'control_centre',
    coordinates_verified = p_verified,
    coordinates_verified_at = case when p_verified then now() else null end,
    coordinates_verified_by = case when auth.role() = 'service_role' then null else auth.uid() end
  where id = p_shop_id;

  if not found then raise exception 'Shop not found'; end if;

  insert into public.automation_events (event_type, payload)
  values (
    'shop_location_updated',
    jsonb_build_object(
      'shop_id', p_shop_id,
      'latitude', round(p_latitude, 7),
      'longitude', round(p_longitude, 7),
      'verified', p_verified,
      'note', p_note,
      'changed_by', auth.uid()
    )
  );
end;
$$;

-- Harden location saving so only operations staff or the server-side WhatsApp
-- webhook may write raw coordinates.
create or replace function public.save_order_location(
  p_order_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_source text,
  p_accuracy_meters numeric default null,
  p_typed_address text default null,
  p_confirmed boolean default false,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role'
     and (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to save delivery locations';
  end if;

  if p_latitude is null or p_latitude < -90 or p_latitude > 90 then
    raise exception 'Latitude must be between -90 and 90';
  end if;

  if p_longitude is null or p_longitude < -180 or p_longitude > 180 then
    raise exception 'Longitude must be between -180 and 180';
  end if;

  if p_source not in ('whatsapp_location', 'whatsapp_live_location', 'control_centre', 'typed_address', 'imported') then
    raise exception 'Invalid location source: %', p_source;
  end if;

  update public.orders
  set
    delivery_latitude = round(p_latitude, 7),
    delivery_longitude = round(p_longitude, 7),
    delivery_address = coalesce(nullif(btrim(p_typed_address), ''), delivery_address),
    location_source = p_source,
    location_accuracy_meters = p_accuracy_meters,
    location_received_at = now(),
    location_confirmed = p_confirmed,
    location_confirmed_at = case when p_confirmed then now() else null end,
    location_corrected_by = case
      when auth.role() <> 'service_role' and p_source = 'control_centre' then auth.uid()
      else location_corrected_by
    end,
    location_note = p_note
  where id = p_order_id;

  if not found then raise exception 'Order not found'; end if;

  insert into public.automation_events (event_type, order_id, payload)
  values (
    'order_location_updated',
    p_order_id,
    jsonb_build_object(
      'latitude', round(p_latitude, 7),
      'longitude', round(p_longitude, 7),
      'source', p_source,
      'accuracy_meters', p_accuracy_meters,
      'confirmed', p_confirmed
    )
  );
end;
$$;

-- Driver presence originates from the driver automation/service or an
-- authorised dispatcher, never from an arbitrary signed-in browser user.
create or replace function public.set_driver_presence(
  p_driver_id uuid,
  p_logged_in boolean,
  p_self_status text default 'available'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role'
     and (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to update driver presence';
  end if;

  if p_self_status not in ('available', 'busy', 'break_requested', 'unavailable') then
    raise exception 'Invalid driver status: %', p_self_status;
  end if;

  insert into public.driver_sessions (
    driver_id, logged_in, self_status, last_seen_at, logged_in_at, logged_out_at
  ) values (
    p_driver_id,
    p_logged_in,
    p_self_status,
    now(),
    case when p_logged_in then now() end,
    case when not p_logged_in then now() end
  )
  on conflict (driver_id) do update
  set
    logged_in = excluded.logged_in,
    self_status = excluded.self_status,
    last_seen_at = now(),
    logged_in_at = case
      when excluded.logged_in and not public.driver_sessions.logged_in then now()
      else public.driver_sessions.logged_in_at
    end,
    logged_out_at = case
      when not excluded.logged_in then now()
      else public.driver_sessions.logged_out_at
    end;
end;
$$;

-- ---------------------------------------------------------
-- EXPLICIT RPC PERMISSIONS
-- Supabase functions are executable by PUBLIC unless revoked.
-- ---------------------------------------------------------

revoke all on function public.register_payment_link(uuid, text, text) from public, anon, authenticated;
revoke all on function public.mark_payment_link_sent(uuid) from public, anon, authenticated;
revoke all on function public.mark_order_paid_from_webhook(uuid, text) from public, anon, authenticated;

grant execute on function public.register_payment_link(uuid, text, text) to service_role;
grant execute on function public.mark_payment_link_sent(uuid) to service_role;
grant execute on function public.mark_order_paid_from_webhook(uuid, text) to service_role;

revoke all on function public.set_driver_presence(uuid, boolean, text) from public, anon;
grant execute on function public.set_driver_presence(uuid, boolean, text) to authenticated, service_role;

revoke all on function public.save_order_location(uuid, numeric, numeric, text, numeric, text, boolean, text) from public, anon;
grant execute on function public.save_order_location(uuid, numeric, numeric, text, numeric, text, boolean, text) to authenticated, service_role;

revoke all on function public.save_shop_location(uuid, numeric, numeric, boolean, text) from public, anon;
grant execute on function public.save_shop_location(uuid, numeric, numeric, boolean, text) to authenticated, service_role;

revoke all on function public.approve_payment_review_with_prices(uuid, jsonb, text) from public, anon;
grant execute on function public.approve_payment_review_with_prices(uuid, jsonb, text) to authenticated;

revoke all on function public.manual_driver_options(uuid) from public, anon;
grant execute on function public.manual_driver_options(uuid) to authenticated;

revoke all on function public.reset_payment_review_for_item_change(uuid) from public, anon, authenticated;
revoke all on function public.sync_approved_order_totals(uuid, numeric, numeric) from public, anon, authenticated;

-- Realtime still listens to base tables; views are refreshed from those events.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'orders', 'order_items', 'drivers', 'driver_sessions', 'delivery_runs',
    'delivery_run_pickups', 'payment_reviews', 'support_queries', 'shops'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;

-- Final read-only confirmation.
select
  (select count(*) from public.control_centre_orders) as dashboard_orders,
  (select count(*) from public.payment_review_queue where status = 'pending_review') as customers_waiting_to_pay,
  (select count(*) from public.driver_control_board where logged_in) as logged_in_drivers,
  (select count(*) from public.delivery_runs r where r.status = 'open' and not exists (
    select 1 from public.orders o where o.delivery_run_id = r.id and o.status <> 'cancelled'
  )) as empty_open_runs,
  (select count(*) from public.map_order_pins where location_quality = 'confirmed') as confirmed_customer_pins,
  (select count(*) from public.map_shop_pins where coordinates_verified) as verified_shop_pins;

-- =========================================================
-- END GETIT v1.6
-- =========================================================
