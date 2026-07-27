-- =========================================================
-- GETIT CONTROL CENTRE v1.5 — DYNAMIC OPERATIONS UPGRADE
-- Run AFTER Getit_v1_4_1_CUMULATIVE_database_upgrade_FIXED.sql
--
-- Adds:
--   • true database-first two-way control-centre actions
--   • driver login / availability / admin override control
--   • payment review before link generation
--   • dynamic driver runs that begin with the first assigned order
--   • exact WhatsApp/GPS coordinates and location quality flags
--   • Realtime publication coverage for all operational tables
--
-- Safe to re-run: objects are created conditionally and functions/views
-- are replaced in place.
-- =========================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- SETTINGS
-- ---------------------------------------------------------

insert into public.app_settings (key, value, description)
values
  ('dynamic_run_window_minutes', '120', 'Maximum collection window beginning when a driver receives the first order'),
  ('realtime_fallback_seconds', '300', 'Emergency dashboard refresh only; normal updates arrive through Supabase Realtime'),
  ('payment_review_required', 'true', 'A staff member must approve an order before a payment link is requested')
on conflict (key) do update
set
  value = excluded.value,
  description = excluded.description,
  updated_at = now();

-- ---------------------------------------------------------
-- DRIVER PRESENCE + CONTROL-CENTRE OVERRIDES
-- ---------------------------------------------------------

create table if not exists public.driver_sessions (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null unique references public.drivers(id) on delete cascade,
  logged_in boolean not null default false,
  self_status text not null default 'available'
    check (self_status in ('available', 'busy', 'break_requested', 'unavailable')),
  system_status text
    check (system_status is null or system_status in ('ready_to_depart', 'out_for_delivery')),
  override_status text
    check (override_status is null or override_status in ('available', 'break', 'unavailable', 'offline')),
  override_reason text,
  override_until timestamptz,
  override_by uuid references public.staff_accounts(user_id) on delete set null,
  last_seen_at timestamptz,
  logged_in_at timestamptz,
  logged_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists driver_sessions_presence_index
on public.driver_sessions (logged_in, self_status, system_status, override_status);

drop trigger if exists set_updated_at on public.driver_sessions;
create trigger set_updated_at
before update on public.driver_sessions
for each row execute function public.set_updated_at();

-- Preserve the current mock behaviour by treating existing active drivers
-- as logged in and available until the real WhatsApp login flow updates them.
insert into public.driver_sessions (driver_id, logged_in, self_status, last_seen_at, logged_in_at)
select d.id, d.active, 'available', now(), case when d.active then now() end
from public.drivers d
on conflict (driver_id) do nothing;

create or replace view public.driver_effective_status as
select
  d.id as driver_id,
  coalesce(
    nullif(to_jsonb(d) ->> 'name', ''),
    nullif(to_jsonb(d) ->> 'full_name', ''),
    nullif(to_jsonb(d) ->> 'driver_name', ''),
    'Driver'
  ) as driver_name,
  d.active,
  coalesce(ds.logged_in, false) as logged_in,
  coalesce(ds.self_status, 'unavailable') as self_status,
  ds.system_status,
  case
    when ds.override_status is not null
      and (ds.override_until is null or ds.override_until > now())
      then ds.override_status
    when coalesce(ds.logged_in, false) = false then 'offline'
    when ds.system_status is not null then ds.system_status
    else coalesce(ds.self_status, 'unavailable')
  end as effective_status,
  ds.override_status,
  ds.override_reason,
  ds.override_until,
  ds.last_seen_at,
  ds.logged_in_at,
  ds.logged_out_at
from public.drivers d
left join public.driver_sessions ds on ds.driver_id = d.id;

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
  if p_self_status not in ('available', 'busy', 'break_requested', 'unavailable') then
    raise exception 'Invalid driver status: %', p_self_status;
  end if;

  insert into public.driver_sessions (
    driver_id,
    logged_in,
    self_status,
    last_seen_at,
    logged_in_at,
    logged_out_at
  )
  values (
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

create or replace function public.override_driver_availability(
  p_driver_id uuid,
  p_status text,
  p_reason text default null,
  p_until timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to override driver availability';
  end if;

  if p_status not in ('available', 'break', 'unavailable', 'offline') then
    raise exception 'Invalid override status: %', p_status;
  end if;

  insert into public.driver_sessions (
    driver_id,
    logged_in,
    self_status,
    override_status,
    override_reason,
    override_until,
    override_by,
    last_seen_at
  )
  values (
    p_driver_id,
    p_status <> 'offline',
    'available',
    p_status,
    p_reason,
    p_until,
    auth.uid(),
    now()
  )
  on conflict (driver_id) do update
  set
    override_status = excluded.override_status,
    override_reason = excluded.override_reason,
    override_until = excluded.override_until,
    override_by = excluded.override_by,
    last_seen_at = now();

  insert into public.automation_events (event_type, driver_id, payload)
  values (
    'driver_availability_overridden',
    p_driver_id,
    jsonb_build_object(
      'status', p_status,
      'reason', p_reason,
      'until', p_until,
      'changed_by', auth.uid()
    )
  );
end;
$$;

create or replace function public.clear_driver_override(p_driver_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to clear driver overrides';
  end if;

  update public.driver_sessions
  set
    override_status = null,
    override_reason = null,
    override_until = null,
    override_by = null
  where driver_id = p_driver_id;

  insert into public.automation_events (event_type, driver_id, payload)
  values ('driver_availability_override_cleared', p_driver_id, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------
-- PAYMENT REVIEW BEFORE LINK GENERATION
-- ---------------------------------------------------------

alter table public.order_items
  add column if not exists review_unit_price numeric(12,2),
  add column if not exists price_verified boolean not null default false,
  add column if not exists review_note text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.staff_accounts(user_id) on delete set null;

-- Copy the current item price into review_unit_price where a recognised
-- price column exists. This block adapts to earlier schema versions.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items' and column_name = 'unit_price'
  ) then
    execute 'update public.order_items set review_unit_price = coalesce(review_unit_price, unit_price)';
  elsif exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items' and column_name = 'price_at_order'
  ) then
    execute 'update public.order_items set review_unit_price = coalesce(review_unit_price, price_at_order)';
  elsif exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items' and column_name = 'current_price'
  ) then
    execute 'update public.order_items set review_unit_price = coalesce(review_unit_price, current_price)';
  end if;
end;
$$;

create table if not exists public.payment_reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  status text not null default 'pending_review'
    check (status in (
      'pending_review',
      'approved',
      'link_requested',
      'link_ready',
      'link_sent',
      'paid',
      'rejected'
    )),
  approved_goods_total numeric(12,2),
  approved_order_total numeric(12,2),
  payment_link text,
  provider_reference text,
  review_note text,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.staff_accounts(user_id) on delete set null,
  link_ready_at timestamptz,
  link_sent_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_reviews_queue_index
on public.payment_reviews (status, requested_at);

drop trigger if exists set_updated_at on public.payment_reviews;
create trigger set_updated_at
before update on public.payment_reviews
for each row execute function public.set_updated_at();

create or replace view public.order_review_lines as
select
  oi.order_id,
  oi.id as order_item_id,
  oi.product_id,
  oi.shop_id,
  coalesce(
    nullif(to_jsonb(p) ->> 'name', ''),
    nullif(to_jsonb(oi) ->> 'item_name', ''),
    'Requested item'
  ) as item_name,
  coalesce(nullif(to_jsonb(s) ->> 'name', ''), 'Unassigned shop') as shop_name,
  oi.quantity,
  oi.review_unit_price,
  round(coalesce(oi.review_unit_price, 0) * oi.quantity, 2) as review_line_total,
  oi.price_verified,
  oi.review_note,
  oi.reviewed_at,
  oi.reviewed_by
from public.order_items oi
left join public.products p on p.id = oi.product_id
left join public.shops s on s.id = oi.shop_id;

create or replace view public.payment_review_queue as
select
  pr.id as payment_review_id,
  pr.order_id,
  o.order_number,
  pr.status,
  pr.requested_at,
  extract(epoch from (now() - pr.requested_at))::integer as waiting_seconds,
  coalesce(nullif(to_jsonb(c) ->> 'name', ''), nullif(to_jsonb(c) ->> 'full_name', ''), 'Customer') as customer_name,
  o.delivery_address,
  o.goods_total as current_goods_total,
  pr.approved_goods_total,
  pr.approved_order_total,
  pr.payment_link,
  pr.review_note,
  count(orl.order_item_id)::integer as item_lines,
  bool_and(coalesce(orl.price_verified, false)) as all_prices_verified,
  coalesce(sum(orl.review_line_total), 0)::numeric(12,2) as reviewed_goods_total
from public.payment_reviews pr
join public.orders o on o.id = pr.order_id
left join public.customers c on c.id = o.customer_id
left join public.order_review_lines orl on orl.order_id = o.id
group by
  pr.id,
  pr.order_id,
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

create or replace function public.ensure_payment_review_pending(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_number text;
begin
  select order_number into v_order_number
  from public.orders where id = p_order_id;

  if not found then
    return;
  end if;

  insert into public.payment_reviews (order_id, status, requested_at)
  values (p_order_id, 'pending_review', now())
  on conflict (order_id) do update
  set
    status = case
      when public.payment_reviews.status = 'paid' then 'paid'
      else 'pending_review'
    end,
    requested_at = case
      when public.payment_reviews.status = 'paid' then public.payment_reviews.requested_at
      else now()
    end,
    approved_goods_total = case when public.payment_reviews.status = 'paid' then public.payment_reviews.approved_goods_total end,
    approved_order_total = case when public.payment_reviews.status = 'paid' then public.payment_reviews.approved_order_total end,
    payment_link = case when public.payment_reviews.status = 'paid' then public.payment_reviews.payment_link end,
    provider_reference = case when public.payment_reviews.status = 'paid' then public.payment_reviews.provider_reference end,
    approved_at = case when public.payment_reviews.status = 'paid' then public.payment_reviews.approved_at end,
    approved_by = case when public.payment_reviews.status = 'paid' then public.payment_reviews.approved_by end,
    link_ready_at = case when public.payment_reviews.status = 'paid' then public.payment_reviews.link_ready_at end,
    link_sent_at = case when public.payment_reviews.status = 'paid' then public.payment_reviews.link_sent_at end;

  if not exists (
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

create or replace function public.payment_review_order_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_status <> 'paid'
     and new.status not in ('delivered', 'cancelled') then
    perform public.ensure_payment_review_pending(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists ensure_payment_review_on_order on public.orders;
create trigger ensure_payment_review_on_order
after insert or update of payment_status, status
on public.orders
for each row execute function public.payment_review_order_trigger();

create or replace function public.payment_review_item_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.ensure_payment_review_pending(old.order_id);
    return old;
  end if;

  perform public.ensure_payment_review_pending(new.order_id);
  return new;
end;
$$;

drop trigger if exists ensure_payment_review_on_item on public.order_items;
create trigger ensure_payment_review_on_item
after insert or update or delete
on public.order_items
for each row execute function public.payment_review_item_trigger();

-- Add existing unpaid orders to the review queue.
do $$
declare
  v_order_id uuid;
begin
  for v_order_id in
    select id from public.orders
    where payment_status <> 'paid'
      and status not in ('delivered', 'cancelled')
  loop
    perform public.ensure_payment_review_pending(v_order_id);
  end loop;
end;
$$;

create or replace function public.update_order_item_review_price(
  p_order_item_id uuid,
  p_unit_price numeric,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to review order prices';
  end if;

  if p_unit_price is null or p_unit_price < 0 then
    raise exception 'Unit price must be zero or greater';
  end if;

  update public.order_items
  set
    review_unit_price = round(p_unit_price, 2),
    price_verified = true,
    review_note = p_note,
    reviewed_at = now(),
    reviewed_by = auth.uid()
  where id = p_order_item_id;

  if not found then
    raise exception 'Order item not found';
  end if;
end;
$$;

create or replace function public.approve_payment_review(
  p_order_id uuid,
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
  v_order public.orders%rowtype;
  v_review_id uuid;
  v_goods_total numeric(12,2);
  v_delivery_fee numeric(12,2) := 0;
  v_second_shop_fee numeric(12,2) := 0;
  v_priority_fee numeric(12,2) := 0;
  v_total numeric(12,2);
  v_items jsonb;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to approve payment reviews';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found';
  end if;

  if not exists (select 1 from public.order_items where order_id = p_order_id) then
    raise exception 'The order has no item lines to approve';
  end if;

  if exists (
    select 1 from public.order_items
    where order_id = p_order_id
      and review_unit_price is null
  ) then
    raise exception 'Every order item needs a reviewed price before approval';
  end if;

  select round(coalesce(sum(quantity * review_unit_price), 0), 2)
  into v_goods_total
  from public.order_items
  where order_id = p_order_id;

  -- Read optional fee fields without tying the migration to one exact
  -- historical orders-table shape.
  v_delivery_fee := coalesce(nullif(to_jsonb(v_order) ->> 'delivery_fee', '')::numeric, 0);
  v_second_shop_fee := coalesce(nullif(to_jsonb(v_order) ->> 'second_shop_fee', '')::numeric, 0);
  v_priority_fee := coalesce(nullif(to_jsonb(v_order) ->> 'priority_fee', '')::numeric, 0);
  v_total := round(v_goods_total + v_delivery_fee + v_second_shop_fee + v_priority_fee, 2);

  select jsonb_agg(
    jsonb_build_object(
      'order_item_id', oi.id,
      'product_id', oi.product_id,
      'shop_id', oi.shop_id,
      'quantity', oi.quantity,
      'unit_price', oi.review_unit_price,
      'line_total', round(oi.quantity * oi.review_unit_price, 2)
    ) order by oi.id
  )
  into v_items
  from public.order_items oi
  where oi.order_id = p_order_id;

  insert into public.payment_reviews (
    order_id,
    status,
    approved_goods_total,
    approved_order_total,
    review_note,
    approved_at,
    approved_by
  )
  values (
    p_order_id,
    'link_requested',
    v_goods_total,
    v_total,
    p_review_note,
    now(),
    auth.uid()
  )
  on conflict (order_id) do update
  set
    status = 'link_requested',
    approved_goods_total = excluded.approved_goods_total,
    approved_order_total = excluded.approved_order_total,
    review_note = excluded.review_note,
    approved_at = excluded.approved_at,
    approved_by = excluded.approved_by,
    payment_link = null,
    provider_reference = null,
    link_ready_at = null,
    link_sent_at = null
  returning id into v_review_id;

  update public.order_items
  set
    price_verified = true,
    reviewed_at = coalesce(reviewed_at, now()),
    reviewed_by = coalesce(reviewed_by, auth.uid())
  where order_id = p_order_id;

  insert into public.automation_events (event_type, order_id, payload)
  values (
    'payment_link_requested',
    p_order_id,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'approved_goods_total', v_goods_total,
      'delivery_fee', v_delivery_fee,
      'second_shop_fee', v_second_shop_fee,
      'priority_fee', v_priority_fee,
      'approved_order_total', v_total,
      'items', coalesce(v_items, '[]'::jsonb),
      'approved_by', auth.uid()
    )
  );

  payment_review_id := v_review_id;
  approved_goods_total := v_goods_total;
  approved_order_total := v_total;
  return next;
end;
$$;

create or replace function public.register_payment_link(
  p_order_id uuid,
  p_payment_link text,
  p_provider_reference text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_number text;
begin
  if p_payment_link is null or btrim(p_payment_link) = '' then
    raise exception 'Payment link is required';
  end if;

  update public.payment_reviews
  set
    status = 'link_ready',
    payment_link = p_payment_link,
    provider_reference = p_provider_reference,
    link_ready_at = now()
  where order_id = p_order_id
    and status in ('approved', 'link_requested', 'link_ready');

  if not found then
    raise exception 'No approved payment review exists for this order';
  end if;

  select order_number into v_order_number from public.orders where id = p_order_id;

  insert into public.automation_events (event_type, order_id, payload)
  values (
    'payment_link_ready',
    p_order_id,
    jsonb_build_object(
      'order_number', v_order_number,
      'payment_link', p_payment_link,
      'provider_reference', p_provider_reference
    )
  );
end;
$$;

create or replace function public.mark_payment_link_sent(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.payment_reviews
  set status = 'link_sent', link_sent_at = now()
  where order_id = p_order_id
    and status in ('link_ready', 'link_sent');
end;
$$;

create or replace function public.mark_order_paid_from_webhook(
  p_order_id uuid,
  p_provider_reference text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders
  set payment_status = 'paid'
  where id = p_order_id;

  update public.payment_reviews
  set
    status = 'paid',
    provider_reference = coalesce(p_provider_reference, provider_reference),
    paid_at = now()
  where order_id = p_order_id;
end;
$$;

-- ---------------------------------------------------------
-- DYNAMIC RUNS — START WHEN THE FIRST ORDER IS ASSIGNED
-- ---------------------------------------------------------

alter table public.delivery_runs
  add column if not exists window_started_at timestamptz,
  add column if not exists window_expires_at timestamptz,
  add column if not exists departure_ready_at timestamptz,
  add column if not exists departed_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists closed_reason text,
  add column if not exists dynamic_window boolean not null default true;

create index if not exists delivery_runs_dynamic_driver_index
on public.delivery_runs (driver_id, status, window_started_at desc);

-- Retain runs containing orders. Remove only empty pre-generated slots,
-- which are the source of the all-day slot clutter.
delete from public.delivery_runs r
where r.status in ('planned', 'open')
  and not exists (
    select 1 from public.orders o
    where o.delivery_run_id = r.id
      and o.status <> 'cancelled'
  );

update public.delivery_runs r
set
  window_started_at = coalesce(r.window_started_at, r.slot_start, r.created_at),
  window_expires_at = coalesce(r.window_expires_at, r.slot_end, coalesce(r.slot_start, r.created_at) + interval '120 minutes'),
  slot_start = coalesce(r.window_started_at, r.slot_start, r.created_at),
  slot_end = coalesce(r.window_expires_at, r.slot_end, coalesce(r.slot_start, r.created_at) + interval '120 minutes'),
  status = case when r.status = 'planned' then 'open' else r.status end,
  dynamic_window = true
where exists (
  select 1 from public.orders o
  where o.delivery_run_id = r.id
    and o.status <> 'cancelled'
);

-- Compatibility function: old dashboard buttons may still call this.
-- v1.5 intentionally creates zero fixed time slots.
create or replace function public.create_delivery_runs_for_date(p_date date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  return 0;
end;
$$;

create or replace function public.close_expired_dynamic_runs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_driver_id uuid;
begin
  for v_driver_id in
    update public.delivery_runs
    set
      status = 'full',
      departure_ready_at = coalesce(departure_ready_at, now()),
      closed_reason = coalesce(closed_reason, 'window_expired')
    where status = 'open'
      and coalesce(window_expires_at, slot_end) <= now()
    returning driver_id
  loop
    v_count := v_count + 1;

    insert into public.driver_sessions (driver_id, logged_in, self_status, system_status, last_seen_at)
    values (v_driver_id, true, 'available', 'ready_to_depart', now())
    on conflict (driver_id) do update
    set system_status = 'ready_to_depart', last_seen_at = now();
  end loop;

  return v_count;
end;
$$;


create or replace function public.get_or_create_dynamic_run(
  p_driver_id uuid,
  p_area_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_minutes integer := 120;
  v_driver public.drivers%rowtype;
  v_now timestamptz := now();
begin
  perform public.close_expired_dynamic_runs();

  select id into v_run_id
  from public.delivery_runs
  where driver_id = p_driver_id
    and status = 'open'
    and coalesce(window_expires_at, slot_end) > v_now
  order by coalesce(window_started_at, slot_start) desc
  limit 1
  for update;

  if found then
    return v_run_id;
  end if;

  if exists (
    select 1 from public.delivery_runs
    where driver_id = p_driver_id
      and status in ('full', 'active')
  ) then
    return null;
  end if;

  select * into v_driver from public.drivers where id = p_driver_id for update;
  if not found or not v_driver.active then
    return null;
  end if;

  select coalesce((value #>> '{}')::integer, 120)
  into v_minutes
  from public.app_settings
  where key = 'dynamic_run_window_minutes';

  insert into public.delivery_runs (
    run_code,
    area_name,
    driver_id,
    slot_start,
    slot_end,
    window_started_at,
    window_expires_at,
    status,
    max_orders,
    max_weight_kg,
    max_space_units,
    dynamic_window
  )
  values (
    'DYN-' || to_char(v_now at time zone 'Africa/Johannesburg', 'YYYYMMDD-HH24MISS') || '-' || substr(md5(gen_random_uuid()::text), 1, 6),
    coalesce(nullif(p_area_name, ''), 'Getit delivery area'),
    p_driver_id,
    v_now,
    v_now + make_interval(mins => v_minutes),
    v_now,
    v_now + make_interval(mins => v_minutes),
    'open',
    v_driver.maximum_orders,
    v_driver.max_weight_kg,
    v_driver.max_space_units,
    true
  )
  returning id into v_run_id;

  return v_run_id;
end;
$$;

-- Replaces v1.4 fixed-slot packing with driver-led dynamic packing.
create or replace function public.auto_pack_order(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_candidate record;
  v_run_id uuid;
  v_next_stop integer;
  v_usage record;
  v_area_name text;
begin
  perform public.close_expired_dynamic_runs();
  perform public.recalculate_order_capacity(p_order_id);

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    return null;
  end if;

  -- Keep an existing assignment only while it still fits an open run.
  if v_order.delivery_run_id is not null then
    if exists (
      select 1
      from public.delivery_runs r
      join lateral (
        select
          count(o.id)::integer as order_count,
          coalesce(sum(o.estimated_weight_kg), 0)::numeric as used_weight,
          coalesce(sum(o.estimated_space_units), 0)::integer as used_space
        from public.orders o
        where o.delivery_run_id = r.id
          and o.status <> 'cancelled'
      ) u on true
      where r.id = v_order.delivery_run_id
        and r.status in ('open', 'full', 'active')
        and u.order_count <= r.max_orders
        and u.used_weight <= r.max_weight_kg
        and u.used_space <= r.max_space_units
    ) then
      return v_order.delivery_run_id;
    end if;

    update public.orders
    set
      delivery_run_id = null,
      assigned_driver_id = null,
      stop_sequence = null,
      scheduled_at = null,
      scheduling_note = 'Removed because the previous driver run can no longer accept this order'
    where id = p_order_id;
  end if;

  if v_order.payment_status <> 'paid'
     or v_order.human_help_required = true
     or v_order.delivery_zone_id is null
     or v_order.status not in ('paid', 'shopping', 'packing', 'ready') then
    update public.orders
    set scheduling_note = case
      when v_order.payment_status <> 'paid' then 'Waiting for payment before assigning a driver'
      when v_order.human_help_required then 'Waiting for the human query to be resolved'
      when v_order.delivery_zone_id is null then 'Waiting for a confirmed delivery area'
      else 'Not eligible for driver assignment'
    end
    where id = p_order_id;
    return null;
  end if;

  select coalesce(nullif(z.town, ''), z.name)
  into v_area_name
  from public.delivery_zones z
  where z.id = v_order.delivery_zone_id;

  -- Show/choose drivers by their actual effective availability. A driver
  -- with a full or active run is excluded until that run is completed.
  select
    d.id as driver_id,
    current_run.id as run_id,
    coalesce(current_run.order_count, 0) as order_count,
    coalesce(current_run.used_weight, 0) as used_weight,
    coalesce(current_run.used_space, 0) as used_space,
    d.maximum_orders,
    d.max_weight_kg,
    d.max_space_units
  into v_candidate
  from public.drivers d
  join public.driver_effective_status des on des.driver_id = d.id
  join public.driver_zones dz
    on dz.driver_id = d.id
   and dz.zone_id = v_order.delivery_zone_id
  left join lateral (
    select
      r.id,
      count(o.id)::integer as order_count,
      coalesce(sum(o.estimated_weight_kg), 0)::numeric as used_weight,
      coalesce(sum(o.estimated_space_units), 0)::integer as used_space,
      coalesce(r.window_started_at, r.slot_start) as started_at
    from public.delivery_runs r
    left join public.orders o
      on o.delivery_run_id = r.id
     and o.status <> 'cancelled'
    where r.driver_id = d.id
      and r.status = 'open'
      and coalesce(r.window_expires_at, r.slot_end) > now()
    group by r.id
    order by coalesce(r.window_started_at, r.slot_start) asc
    limit 1
  ) current_run on true
  where d.active = true
    and des.effective_status = 'available'
    and not exists (
      select 1 from public.delivery_runs blocked
      where blocked.driver_id = d.id
        and blocked.status in ('full', 'active')
    )
    and coalesce(current_run.order_count, 0) + 1 <= d.maximum_orders
    and coalesce(current_run.used_weight, 0) + v_order.estimated_weight_kg <= d.max_weight_kg
    and coalesce(current_run.used_space, 0) + v_order.estimated_space_units <= d.max_space_units
  order by
    case when current_run.id is not null then 0 else 1 end,
    coalesce(current_run.started_at, now()) asc,
    greatest(
      (coalesce(current_run.order_count, 0) + 1)::numeric / nullif(d.maximum_orders, 0),
      (coalesce(current_run.used_weight, 0) + v_order.estimated_weight_kg) / nullif(d.max_weight_kg, 0),
      (coalesce(current_run.used_space, 0) + v_order.estimated_space_units)::numeric / nullif(d.max_space_units, 0)
    ) asc,
    d.id
  limit 1
  for update of d skip locked;

  if not found then
    update public.orders
    set scheduling_note = 'Waiting for an available logged-in driver with enough bucket capacity'
    where id = p_order_id;
    return null;
  end if;

  v_run_id := v_candidate.run_id;
  if v_run_id is null then
    v_run_id := public.get_or_create_dynamic_run(v_candidate.driver_id, v_area_name);
  end if;

  if v_run_id is null then
    update public.orders
    set scheduling_note = 'Selected driver is finishing another run'
    where id = p_order_id;
    return null;
  end if;

  select coalesce(max(stop_sequence), 0) + 1
  into v_next_stop
  from public.orders
  where delivery_run_id = v_run_id
    and status <> 'cancelled';

  update public.orders
  set
    delivery_run_id = v_run_id,
    assigned_driver_id = v_candidate.driver_id,
    delivery_slot_start = (select coalesce(window_started_at, slot_start) from public.delivery_runs where id = v_run_id),
    delivery_slot_end = (select coalesce(window_expires_at, slot_end) from public.delivery_runs where id = v_run_id),
    stop_sequence = v_next_stop,
    scheduled_at = now(),
    scheduling_note = 'Assigned to the driver’s current dynamic collection window'
  where id = p_order_id;

  perform public.sync_delivery_run_pickups(v_run_id);

  select
    count(o.id)::integer as order_count,
    coalesce(sum(o.estimated_weight_kg), 0)::numeric as used_weight,
    coalesce(sum(o.estimated_space_units), 0)::integer as used_space,
    r.max_orders,
    r.max_weight_kg,
    r.max_space_units,
    r.driver_id
  into v_usage
  from public.delivery_runs r
  left join public.orders o
    on o.delivery_run_id = r.id
   and o.status <> 'cancelled'
  where r.id = v_run_id
  group by r.id;

  if v_usage.order_count >= v_usage.max_orders
     or v_usage.used_weight >= v_usage.max_weight_kg
     or v_usage.used_space >= v_usage.max_space_units then
    update public.delivery_runs
    set
      status = 'full',
      departure_ready_at = now(),
      closed_reason = 'capacity_reached'
    where id = v_run_id;

    insert into public.driver_sessions (driver_id, logged_in, self_status, system_status, last_seen_at)
    values (v_usage.driver_id, true, 'available', 'ready_to_depart', now())
    on conflict (driver_id) do update
    set system_status = 'ready_to_depart', last_seen_at = now();
  end if;

  return v_run_id;
end;
$$;

create or replace function public.auto_pack_waiting_orders()
returns table (processed integer, assigned integer, waiting integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_run_id uuid;
  v_processed integer := 0;
  v_assigned integer := 0;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to pack delivery runs';
  end if;

  perform public.close_expired_dynamic_runs();

  for v_order in
    select id
    from public.orders
    where delivery_run_id is null
      and payment_status = 'paid'
      and human_help_required = false
      and delivery_zone_id is not null
      and status in ('paid', 'shopping', 'packing', 'ready')
    order by priority desc, created_at asc
  loop
    v_processed := v_processed + 1;
    v_run_id := public.auto_pack_order(v_order.id);
    if v_run_id is not null then
      v_assigned := v_assigned + 1;
    end if;
  end loop;

  processed := v_processed;
  assigned := v_assigned;
  waiting := v_processed - v_assigned;
  return next;
end;
$$;

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
    select * from public.orders where id = p_order_id
  ), driver_load as (
    select
      d.id as driver_id,
      r.id as run_id,
      count(o.id)::integer as order_count,
      coalesce(sum(o.estimated_weight_kg), 0)::numeric as used_weight,
      coalesce(sum(o.estimated_space_units), 0)::integer as used_space
    from public.drivers d
    left join public.delivery_runs r
      on r.driver_id = d.id
     and r.status = 'open'
     and coalesce(r.window_expires_at, r.slot_end) > now()
    left join public.orders o
      on o.delivery_run_id = r.id
     and o.status <> 'cancelled'
    group by d.id, r.id
  )
  select
    d.id,
    des.driver_name,
    des.effective_status,
    des.logged_in,
    exists (
      select 1
      from public.driver_zones dz
      join target_order t on t.delivery_zone_id = dz.zone_id
      where dz.driver_id = d.id
    ) as services_order_zone,
    dl.run_id,
    coalesce(dl.order_count, 0),
    d.maximum_orders,
    coalesce(dl.used_weight, 0),
    d.max_weight_kg,
    coalesce(dl.used_space, 0),
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
        select 1 from public.delivery_runs blocked
        where blocked.driver_id = d.id
          and blocked.status in ('full', 'active')
      )
      and coalesce(dl.order_count, 0) + 1 <= d.maximum_orders
      and coalesce(dl.used_weight, 0) + (select estimated_weight_kg from target_order) <= d.max_weight_kg
      and coalesce(dl.used_space, 0) + (select estimated_space_units from target_order) <= d.max_space_units
    ) as can_assign,
    case
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
      when coalesce(dl.order_count, 0) + 1 > d.maximum_orders then 'Maximum order count reached'
      when coalesce(dl.used_weight, 0) + (select estimated_weight_kg from target_order) > d.max_weight_kg then 'Weight capacity would be exceeded'
      when coalesce(dl.used_space, 0) + (select estimated_space_units from target_order) > d.max_space_units then 'Bucket space would be exceeded'
      else null
    end as unavailable_reason
  from public.drivers d
  join public.driver_effective_status des on des.driver_id = d.id
  left join driver_load dl on dl.driver_id = d.id
  order by
    case when des.effective_status = 'available' then 0 else 1 end,
    des.driver_name;
$$;

create or replace function public.assign_order_to_driver(
  p_order_id uuid,
  p_driver_id uuid,
  p_force boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_driver_option record;
  v_area_name text;
  v_run_id uuid;
  v_old_run_id uuid;
  v_next_stop integer;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to assign drivers';
  end if;

  perform public.close_expired_dynamic_runs();
  perform public.recalculate_order_capacity(p_order_id);

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;

  select * into v_driver_option
  from public.manual_driver_options(p_order_id)
  where driver_id = p_driver_id;

  if not found then raise exception 'Driver not found'; end if;

  if not p_force and not v_driver_option.can_assign then
    raise exception '%', coalesce(v_driver_option.unavailable_reason, 'Driver cannot accept this order');
  end if;

  if exists (
    select 1 from public.delivery_runs
    where driver_id = p_driver_id
      and status in ('full', 'active')
  ) then
    raise exception 'Driver is finishing another run';
  end if;

  -- Force may bypass zone/availability, but never physical capacity.
  if v_driver_option.current_order_count + 1 > v_driver_option.maximum_orders
     or v_driver_option.used_weight_kg + v_order.estimated_weight_kg > v_driver_option.max_weight_kg
     or v_driver_option.used_space_units + v_order.estimated_space_units > v_driver_option.max_space_units then
    raise exception 'Driver capacity would be exceeded';
  end if;

  select coalesce(nullif(z.town, ''), z.name)
  into v_area_name
  from public.delivery_zones z
  where z.id = v_order.delivery_zone_id;

  v_run_id := public.get_or_create_dynamic_run(p_driver_id, v_area_name);
  if v_run_id is null then
    raise exception 'Driver cannot begin a new run yet';
  end if;

  v_old_run_id := v_order.delivery_run_id;

  select coalesce(max(stop_sequence), 0) + 1 into v_next_stop
  from public.orders
  where delivery_run_id = v_run_id
    and status <> 'cancelled';

  update public.orders
  set
    delivery_run_id = v_run_id,
    assigned_driver_id = p_driver_id,
    delivery_slot_start = (select coalesce(window_started_at, slot_start) from public.delivery_runs where id = v_run_id),
    delivery_slot_end = (select coalesce(window_expires_at, slot_end) from public.delivery_runs where id = v_run_id),
    stop_sequence = v_next_stop,
    scheduled_at = now(),
    scheduling_note = case when p_force then 'Manually assigned with control-centre override' else 'Manually assigned by the control centre' end
  where id = p_order_id;

  perform public.sync_delivery_run_pickups(v_old_run_id);
  perform public.sync_delivery_run_pickups(v_run_id);
  perform public.normalize_delivery_run_stops(v_old_run_id);
  perform public.normalize_delivery_run_stops(v_run_id);

  return v_run_id;
end;
$$;

create or replace function public.depart_delivery_run(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver_id uuid;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to dispatch drivers';
  end if;

  update public.delivery_runs
  set
    status = 'active',
    departed_at = now(),
    closed_reason = coalesce(closed_reason, 'departed_early')
  where id = p_run_id
    and status in ('open', 'full')
  returning driver_id into v_driver_id;

  if not found then raise exception 'Run is not ready to depart'; end if;

  insert into public.driver_sessions (driver_id, logged_in, self_status, system_status, last_seen_at)
  values (v_driver_id, true, 'available', 'out_for_delivery', now())
  on conflict (driver_id) do update
  set system_status = 'out_for_delivery', last_seen_at = now();
end;
$$;

create or replace function public.complete_delivery_run(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver_id uuid;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to complete driver runs';
  end if;

  update public.delivery_runs
  set status = 'completed', completed_at = now()
  where id = p_run_id
    and status in ('active', 'full', 'open')
  returning driver_id into v_driver_id;

  if not found then raise exception 'Run cannot be completed'; end if;

  update public.driver_sessions
  set system_status = null, last_seen_at = now()
  where driver_id = v_driver_id;

  perform public.auto_pack_waiting_orders();
end;
$$;

create or replace view public.driver_control_board as
select
  des.driver_id,
  des.driver_name,
  des.active,
  des.logged_in,
  des.self_status,
  des.effective_status,
  des.override_status,
  des.override_reason,
  des.override_until,
  des.last_seen_at,
  r.id as current_run_id,
  r.run_code,
  r.area_name,
  r.status as run_status,
  coalesce(r.window_started_at, r.slot_start) as window_started_at,
  coalesce(r.window_expires_at, r.slot_end) as window_expires_at,
  r.departure_ready_at,
  r.departed_at,
  coalesce(run_usage.order_count, 0)::integer as order_count,
  r.max_orders,
  coalesce(run_usage.used_weight, 0)::numeric(12,2) as used_weight_kg,
  r.max_weight_kg,
  coalesce(run_usage.used_space, 0)::integer as used_space_units,
  r.max_space_units,
  run_usage.oldest_order_at,
  case
    when r.id is null then null
    else greatest(
      coalesce(run_usage.order_count, 0)::numeric / nullif(r.max_orders, 0),
      coalesce(run_usage.used_weight, 0) / nullif(r.max_weight_kg, 0),
      coalesce(run_usage.used_space, 0)::numeric / nullif(r.max_space_units, 0)
    )
  end as load_ratio
from public.driver_effective_status des
left join lateral (
  select dr.*
  from public.delivery_runs dr
  where dr.driver_id = des.driver_id
    and dr.status in ('open', 'full', 'active')
  order by coalesce(dr.window_started_at, dr.slot_start) desc
  limit 1
) r on true
left join lateral (
  select
    count(o.id)::integer as order_count,
    coalesce(sum(o.estimated_weight_kg), 0)::numeric as used_weight,
    coalesce(sum(o.estimated_space_units), 0)::integer as used_space,
    min(o.created_at) as oldest_order_at
  from public.orders o
  where o.delivery_run_id = r.id
    and o.status <> 'cancelled'
) run_usage on true;

-- ---------------------------------------------------------
-- ACCURATE WHATSAPP / GPS MAP PINS
-- ---------------------------------------------------------

alter table public.orders
  add column if not exists location_source text,
  add column if not exists location_accuracy_meters numeric(10,2),
  add column if not exists location_received_at timestamptz,
  add column if not exists location_confirmed boolean not null default false,
  add column if not exists location_confirmed_at timestamptz,
  add column if not exists location_corrected_by uuid references public.staff_accounts(user_id) on delete set null,
  add column if not exists location_note text;

alter table public.shops
  add column if not exists coordinate_source text,
  add column if not exists coordinates_verified boolean not null default false,
  add column if not exists coordinates_verified_at timestamptz,
  add column if not exists coordinates_verified_by uuid references public.staff_accounts(user_id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_location_source_valid') then
    alter table public.orders add constraint orders_location_source_valid
      check (location_source is null or location_source in ('whatsapp_location', 'whatsapp_live_location', 'control_centre', 'typed_address', 'imported'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'orders_delivery_latitude_valid') then
    alter table public.orders add constraint orders_delivery_latitude_valid
      check (delivery_latitude is null or delivery_latitude between -90 and 90);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'orders_delivery_longitude_valid') then
    alter table public.orders add constraint orders_delivery_longitude_valid
      check (delivery_longitude is null or delivery_longitude between -180 and 180);
  end if;
end;
$$;

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
    location_corrected_by = case when p_source = 'control_centre' then auth.uid() else location_corrected_by end,
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

create or replace function public.confirm_order_location(
  p_order_id uuid,
  p_confirmed boolean,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to confirm delivery locations';
  end if;

  update public.orders
  set
    location_confirmed = p_confirmed,
    location_confirmed_at = case when p_confirmed then now() else null end,
    location_corrected_by = auth.uid(),
    location_note = coalesce(p_note, location_note)
  where id = p_order_id;
end;
$$;

create or replace view public.map_order_pins as
select
  o.id as order_id,
  o.order_number,
  o.assigned_driver_id,
  o.delivery_run_id,
  o.stop_sequence,
  o.delivery_address,
  o.delivery_latitude as latitude,
  o.delivery_longitude as longitude,
  o.location_source,
  o.location_accuracy_meters,
  o.location_confirmed,
  o.location_received_at,
  case
    when o.delivery_latitude is null or o.delivery_longitude is null then 'missing'
    when o.location_source in ('whatsapp_location', 'whatsapp_live_location', 'control_centre')
      and (o.location_accuracy_meters is null or o.location_accuracy_meters <= 100)
      and o.location_confirmed then 'confirmed'
    when o.location_source in ('whatsapp_location', 'whatsapp_live_location', 'control_centre')
      and (o.location_accuracy_meters is null or o.location_accuracy_meters <= 100) then 'gps_received'
    else 'needs_confirmation'
  end as location_quality,
  case
    when o.delivery_latitude is not null and o.delivery_longitude is not null then
      'https://www.google.com/maps/search/?api=1&query=' || o.delivery_latitude::text || ',' || o.delivery_longitude::text
  end as google_maps_url
from public.orders o;

create or replace view public.map_shop_pins as
select
  s.id as shop_id,
  coalesce(nullif(to_jsonb(s) ->> 'name', ''), 'Shop') as shop_name,
  s.latitude,
  s.longitude,
  s.coordinate_source,
  s.coordinates_verified,
  s.coordinates_verified_at,
  case
    when s.latitude is not null and s.longitude is not null then
      'https://www.google.com/maps/search/?api=1&query=' || s.latitude::text || ',' || s.longitude::text
  end as google_maps_url
from public.shops s;

-- Existing fictional coordinates must not appear verified.
update public.shops
set coordinate_source = coalesce(coordinate_source, 'mock'), coordinates_verified = false
where coordinates_verified = false;

update public.orders
set
  location_source = coalesce(location_source, 'imported'),
  location_confirmed = false
where delivery_latitude is not null
  and delivery_longitude is not null
  and location_source is null;

-- ---------------------------------------------------------
-- SECURITY
-- ---------------------------------------------------------

alter table public.driver_sessions enable row level security;
alter table public.payment_reviews enable row level security;

grant select, insert, update, delete on public.driver_sessions to authenticated;
grant select, insert, update, delete on public.payment_reviews to authenticated;

drop policy if exists "operations staff manage driver sessions" on public.driver_sessions;
create policy "operations staff manage driver sessions"
on public.driver_sessions
for all
to authenticated
using ((select public.current_staff_role()) in ('owner', 'admin', 'dispatcher'))
with check ((select public.current_staff_role()) in ('owner', 'admin', 'dispatcher'));

drop policy if exists "operations staff manage payment reviews" on public.payment_reviews;
create policy "operations staff manage payment reviews"
on public.payment_reviews
for all
to authenticated
using ((select public.current_staff_role()) in ('owner', 'admin', 'dispatcher'))
with check ((select public.current_staff_role()) in ('owner', 'admin', 'dispatcher'));

grant select on public.driver_effective_status to authenticated;
grant select on public.driver_control_board to authenticated;
grant select on public.order_review_lines to authenticated;
grant select on public.payment_review_queue to authenticated;
grant select on public.map_order_pins to authenticated;
grant select on public.map_shop_pins to authenticated;

grant execute on function public.override_driver_availability(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.clear_driver_override(uuid) to authenticated;
grant execute on function public.set_driver_presence(uuid, boolean, text) to authenticated;
grant execute on function public.update_order_item_review_price(uuid, numeric, text) to authenticated;
grant execute on function public.approve_payment_review(uuid, text) to authenticated;
grant execute on function public.manual_driver_options(uuid) to authenticated;
grant execute on function public.assign_order_to_driver(uuid, uuid, boolean) to authenticated;
grant execute on function public.depart_delivery_run(uuid) to authenticated;
grant execute on function public.complete_delivery_run(uuid) to authenticated;
grant execute on function public.confirm_order_location(uuid, boolean, text) to authenticated;
grant execute on function public.save_order_location(uuid, numeric, numeric, text, numeric, text, boolean, text) to authenticated;
grant execute on function public.auto_pack_waiting_orders() to authenticated;
grant execute on function public.close_expired_dynamic_runs() to authenticated;

-- ---------------------------------------------------------
-- REALTIME — BOTH DIRECTIONS USE SUPABASE AS SOURCE OF TRUTH
-- ---------------------------------------------------------

-- Include every operational table that can change from the control centre,
-- drivers, payment automation, or customer/WhatsApp webhooks.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'orders',
    'order_items',
    'drivers',
    'driver_sessions',
    'driver_zones',
    'delivery_zones',
    'delivery_runs',
    'delivery_run_pickups',
    'payment_reviews',
    'support_queries',
    'automation_events',
    'customers',
    'shops',
    'products',
    'staff_accounts'
  ]
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;

-- Full replica identity gives the dashboard useful previous values for
-- updates/deletes and makes rollback/error displays clearer.
alter table public.orders replica identity full;
alter table public.order_items replica identity full;
alter table public.drivers replica identity full;
alter table public.driver_sessions replica identity full;
alter table public.delivery_runs replica identity full;
alter table public.delivery_run_pickups replica identity full;
alter table public.payment_reviews replica identity full;
alter table public.support_queries replica identity full;
alter table public.shops replica identity full;

-- ---------------------------------------------------------
-- FINAL CHECK
-- ---------------------------------------------------------

select
  (select count(*) from public.payment_reviews where status = 'pending_review') as payment_reviews_waiting,
  (select count(*) from public.driver_effective_status where logged_in) as drivers_logged_in,
  (select count(*) from public.delivery_runs where status in ('open', 'full', 'active')) as current_driver_runs,
  (select count(*) from public.map_order_pins where location_quality = 'confirmed') as confirmed_delivery_pins,
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public') as realtime_tables;

-- =========================================================
-- END GETIT v1.5
-- =========================================================
