-- =========================================================
-- GETIT CONTROL CENTRE v1.3 DATABASE UPGRADE
-- Adds real support-query history and an automation outbox
-- for future Respond.io + n8n + WhatsApp driver updates.
-- Safe to run once on the existing Getit Supabase project.
-- =========================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- SUPPORT QUERIES
-- Every customer issue becomes a record that can be resolved
-- without changing the order status automatically.
-- ---------------------------------------------------------

create table if not exists public.support_queries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  status text not null default 'open'
    check (status in ('open', 'resolved')),
  issue_type text not null default 'other'
    check (issue_type in ('payment', 'location', 'product', 'delivery', 'customer_request', 'other')),
  issue_summary text not null,
  details jsonb not null default '{}'::jsonb,
  opened_by text not null default 'system',
  resolution_note text,
  resolved_by uuid references public.staff_accounts(user_id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists support_queries_order_status_index
on public.support_queries (order_id, status, created_at desc);

drop trigger if exists set_updated_at on public.support_queries;
create trigger set_updated_at
before update on public.support_queries
for each row
execute function public.set_updated_at();

-- Keep the red human-help flag on orders in sync with open queries.
create or replace function public.sync_order_support_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_order_id uuid;
  latest_issue text;
  has_open_query boolean;
begin
  if tg_op = 'DELETE' then
    affected_order_id := old.order_id;
  else
    affected_order_id := new.order_id;
  end if;

  select
    exists (
      select 1
      from public.support_queries
      where order_id = affected_order_id
        and status = 'open'
    ),
    (
      select issue_summary
      from public.support_queries
      where order_id = affected_order_id
        and status = 'open'
      order by created_at desc
      limit 1
    )
  into has_open_query, latest_issue;

  update public.orders
  set
    human_help_required = has_open_query,
    support_issue = latest_issue
  where id = affected_order_id;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_order_support_flag on public.support_queries;
create trigger sync_order_support_flag
after insert or update or delete
on public.support_queries
for each row
execute function public.sync_order_support_flag();

-- Turn any existing red human-help order into a proper open query.
insert into public.support_queries (
  order_id,
  issue_type,
  issue_summary,
  opened_by
)
select
  o.id,
  case
    when lower(coalesce(o.support_issue, '')) like '%pay%' then 'payment'
    when lower(coalesce(o.support_issue, '')) like '%location%' then 'location'
    when lower(coalesce(o.support_issue, '')) like '%deliver%' then 'delivery'
    when lower(coalesce(o.support_issue, '')) like '%item%'
      or lower(coalesce(o.support_issue, '')) like '%product%' then 'product'
    else 'other'
  end,
  coalesce(o.support_issue, 'Customer requires human assistance'),
  'migration'
from public.orders o
where o.human_help_required = true
  and not exists (
    select 1
    from public.support_queries q
    where q.order_id = o.id
      and q.status = 'open'
  );

-- ---------------------------------------------------------
-- AUTOMATION OUTBOX
-- n8n will later watch pending events and send Respond.io or
-- WhatsApp messages. The browser never receives a secret key.
-- ---------------------------------------------------------

create table if not exists public.automation_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  order_id uuid references public.orders(id) on delete cascade,
  driver_id uuid references public.drivers(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists automation_events_pending_index
on public.automation_events (status, created_at);

create index if not exists automation_events_order_index
on public.automation_events (order_id, created_at desc);

drop trigger if exists set_updated_at on public.automation_events;
create trigger set_updated_at
before update on public.automation_events
for each row
execute function public.set_updated_at();

create or replace function public.queue_getit_order_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.automation_events (event_type, order_id, driver_id, payload)
    values (
      'order_created',
      new.id,
      new.assigned_driver_id,
      jsonb_build_object(
        'order_number', new.order_number,
        'status', new.status,
        'payment_status', new.payment_status,
        'priority', new.priority,
        'delivery_address', new.delivery_address,
        'delivery_zone_id', new.delivery_zone_id,
        'distance_km', new.distance_km,
        'estimated_minutes', new.estimated_minutes
      )
    );
    return new;
  end if;

  if new.assigned_driver_id is distinct from old.assigned_driver_id then
    insert into public.automation_events (event_type, order_id, driver_id, payload)
    values (
      case when new.assigned_driver_id is null then 'driver_unassigned' else 'driver_assigned' end,
      new.id,
      new.assigned_driver_id,
      jsonb_build_object(
        'order_number', new.order_number,
        'previous_driver_id', old.assigned_driver_id,
        'driver_id', new.assigned_driver_id,
        'delivery_address', new.delivery_address,
        'delivery_zone_id', new.delivery_zone_id,
        'distance_km', new.distance_km,
        'estimated_minutes', new.estimated_minutes,
        'delivery_slot_start', new.delivery_slot_start,
        'delivery_slot_end', new.delivery_slot_end,
        'priority', new.priority
      )
    );
  end if;

  if new.status is distinct from old.status then
    insert into public.automation_events (event_type, order_id, driver_id, payload)
    values (
      'order_status_changed',
      new.id,
      new.assigned_driver_id,
      jsonb_build_object(
        'order_number', new.order_number,
        'old_status', old.status,
        'new_status', new.status
      )
    );
  end if;

  if new.payment_status is distinct from old.payment_status then
    insert into public.automation_events (event_type, order_id, driver_id, payload)
    values (
      'payment_status_changed',
      new.id,
      new.assigned_driver_id,
      jsonb_build_object(
        'order_number', new.order_number,
        'old_payment_status', old.payment_status,
        'new_payment_status', new.payment_status
      )
    );
  end if;

  if new.human_help_required is distinct from old.human_help_required then
    insert into public.automation_events (event_type, order_id, driver_id, payload)
    values (
      case when new.human_help_required then 'support_requested' else 'support_resolved' end,
      new.id,
      new.assigned_driver_id,
      jsonb_build_object(
        'order_number', new.order_number,
        'human_help_required', new.human_help_required,
        'support_issue', new.support_issue
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists queue_getit_order_event on public.orders;
create trigger queue_getit_order_event
after insert or update
on public.orders
for each row
execute function public.queue_getit_order_event();

-- ---------------------------------------------------------
-- SECURITY
-- Owner/admin may operate these tables from the dashboard.
-- n8n will later use a server-side secret and process events.
-- ---------------------------------------------------------

alter table public.support_queries enable row level security;
alter table public.automation_events enable row level security;

grant select, insert, update, delete on public.support_queries to authenticated;
grant select on public.automation_events to authenticated;

drop policy if exists "owner and admin full access" on public.support_queries;
create policy "owner and admin full access"
on public.support_queries
for all
to authenticated
using ((select public.current_staff_role()) in ('owner', 'admin'))
with check ((select public.current_staff_role()) in ('owner', 'admin'));

drop policy if exists "owner and admin view automation events" on public.automation_events;
create policy "owner and admin view automation events"
on public.automation_events
for select
to authenticated
using ((select public.current_staff_role()) in ('owner', 'admin'));

-- ---------------------------------------------------------
-- REALTIME
-- The dashboard listens for changes instead of hammering the
-- database with constant refreshes. It also has a 60s fallback.
-- ---------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'orders',
    'drivers',
    'customers',
    'delivery_zones',
    'driver_zones',
    'support_queries',
    'staff_accounts'
  ]
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format(
        'alter publication supabase_realtime add table public.%I',
        table_name
      );
    end if;
  end loop;
end;
$$;

-- Final check
select
  (select count(*) from public.support_queries where status = 'open') as open_queries,
  (select count(*) from public.automation_events where status = 'pending') as pending_automation_events;

-- =========================================================
-- GETIT CONTROL CENTRE v1.4 DATABASE UPGRADE
-- Adds delivery runs, capacity estimates, automatic packing,
-- manual stop ordering and map-ready delivery coordinates.
-- This file ALREADY INCLUDES v1.3 above.
-- =========================================================

-- ---------------------------------------------------------
-- SETTINGS
-- ---------------------------------------------------------

insert into public.app_settings (key, value, description)
values
  ('run_start_hour', '8', 'First standard delivery run hour in Africa/Johannesburg'),
  ('run_end_hour', '20', 'Last standard delivery run cutoff hour in Africa/Johannesburg'),
  ('run_interval_minutes', '120', 'Minutes between standard delivery runs'),
  ('default_driver_weight_capacity_kg', '40', 'Default safe load estimate per driver run'),
  ('default_driver_space_capacity', '100', 'Default space points per driver bucket'),
  ('auto_pack_enabled', 'true', 'Automatically place eligible orders into the earliest suitable run')
on conflict (key) do update
set
  value = excluded.value,
  description = excluded.description,
  updated_at = now();

-- ---------------------------------------------------------
-- PRODUCT CAPACITY ESTIMATES
-- Space points are deliberately simple. They do not need to
-- be perfect; they only need to prevent obviously bad loads.
-- ---------------------------------------------------------

alter table public.products
  add column if not exists estimated_weight_kg numeric(8,3) not null default 0.500,
  add column if not exists space_units integer not null default 2,
  add column if not exists handling_type text not null default 'normal';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'products_estimated_weight_nonnegative'
  ) then
    alter table public.products
      add constraint products_estimated_weight_nonnegative
      check (estimated_weight_kg >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'products_space_units_positive'
  ) then
    alter table public.products
      add constraint products_space_units_positive
      check (space_units > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'products_handling_type_valid'
  ) then
    alter table public.products
      add constraint products_handling_type_valid
      check (handling_type in ('normal', 'fragile', 'bulky', 'cold'));
  end if;
end;
$$;

-- Sensible fictional estimates for the current mock catalogue.
update public.products
set
  estimated_weight_kg = case
    when name = 'Full Cream Milk' then 2.100
    when name = 'White Bread' then 0.750
    when name = 'Large Eggs' then 1.250
    when name = 'Cheddar Cheese' then 0.550
    when name = 'Cake Flour' then 2.550
    when name = 'Sugar' then 2.550
    when name = 'Maize Meal' then 10.200
    when name = 'Cinnamon' then 0.080
    when name = 'Cornflour' then 0.550
    when name = 'Vanilla Essence' then 0.140
    when name = 'LED Light Bulb' then 0.120
    when name = 'Paracetamol' then 0.080
    else estimated_weight_kg
  end,
  space_units = case
    when name = 'Full Cream Milk' then 6
    when name = 'White Bread' then 5
    when name = 'Large Eggs' then 7
    when name = 'Cheddar Cheese' then 3
    when name = 'Cake Flour' then 7
    when name = 'Sugar' then 7
    when name = 'Maize Meal' then 22
    when name = 'Cinnamon' then 1
    when name = 'Cornflour' then 2
    when name = 'Vanilla Essence' then 1
    when name = 'LED Light Bulb' then 3
    when name = 'Paracetamol' then 1
    else space_units
  end,
  handling_type = case
    when name in ('White Bread', 'Large Eggs', 'LED Light Bulb') then 'fragile'
    when name = 'Maize Meal' then 'bulky'
    when name in ('Full Cream Milk', 'Cheddar Cheese') then 'cold'
    else 'normal'
  end;

-- ---------------------------------------------------------
-- DRIVER BUCKET CAPACITY
-- ---------------------------------------------------------

alter table public.drivers
  add column if not exists max_weight_kg numeric(8,2) not null default 40,
  add column if not exists max_space_units integer not null default 100,
  add column if not exists bucket_label text;

update public.drivers
set bucket_label = coalesce(bucket_label, 'Standard Getit bucket');

-- ---------------------------------------------------------
-- DELIVERY RUNS
-- A run is one driver, one time slot and one grouped load.
-- ---------------------------------------------------------

create table if not exists public.delivery_runs (
  id uuid primary key default gen_random_uuid(),
  run_code text unique not null,
  area_name text not null,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  status text not null default 'planned'
    check (status in ('planned', 'open', 'full', 'active', 'completed', 'cancelled')),
  max_orders integer not null default 8 check (max_orders > 0),
  max_weight_kg numeric(8,2) not null default 40 check (max_weight_kg > 0),
  max_space_units integer not null default 100 check (max_space_units > 0),
  notes text,
  created_by uuid references public.staff_accounts(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (driver_id, slot_start)
);

create index if not exists delivery_runs_slot_index
on public.delivery_runs (slot_start, status);

create index if not exists delivery_runs_driver_index
on public.delivery_runs (driver_id, slot_start);

drop trigger if exists set_updated_at on public.delivery_runs;
create trigger set_updated_at
before update on public.delivery_runs
for each row
execute function public.set_updated_at();

-- Every run may require pickups from one or more shops before
-- the driver starts the customer drop-off sequence.
create table if not exists public.delivery_run_pickups (
  id uuid primary key default gen_random_uuid(),
  delivery_run_id uuid not null references public.delivery_runs(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  pickup_sequence integer not null default 999,
  status text not null default 'pending'
    check (status in ('pending', 'collecting', 'collected', 'skipped')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (delivery_run_id, shop_id)
);

create index if not exists delivery_run_pickups_run_index
on public.delivery_run_pickups (delivery_run_id, pickup_sequence);

drop trigger if exists set_updated_at on public.delivery_run_pickups;
create trigger set_updated_at
before update on public.delivery_run_pickups
for each row
execute function public.set_updated_at();

-- ---------------------------------------------------------
-- ORDER SCHEDULING FIELDS
-- ---------------------------------------------------------

alter table public.orders
  add column if not exists delivery_run_id uuid references public.delivery_runs(id) on delete set null,
  add column if not exists stop_sequence integer,
  add column if not exists estimated_weight_kg numeric(8,3) not null default 0,
  add column if not exists estimated_space_units integer not null default 0,
  add column if not exists estimated_bag_count integer not null default 1,
  add column if not exists scheduling_note text,
  add column if not exists scheduled_at timestamptz;

create index if not exists orders_delivery_run_index
on public.orders (delivery_run_id, stop_sequence);

-- ---------------------------------------------------------
-- ORDER CAPACITY CALCULATION
-- ---------------------------------------------------------

create or replace function public.recalculate_order_capacity(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_weight numeric(8,3);
  v_space integer;
  v_lines integer;
begin
  select
    coalesce(sum(oi.quantity * coalesce(p.estimated_weight_kg, 0.5)), 0)::numeric(8,3),
    coalesce(ceil(sum(oi.quantity * coalesce(p.space_units, 2)))::integer, 0),
    count(*)::integer
  into v_weight, v_space, v_lines
  from public.order_items oi
  left join public.products p on p.id = oi.product_id
  where oi.order_id = p_order_id;

  -- Orders without item rows still receive a small mock estimate
  -- so they can be tested in the packing system.
  if v_lines = 0 then
    select
      greatest(1.0, least(12.0, coalesce(goods_total, 0) / 40.0))::numeric(8,3),
      greatest(4, least(30, ceil(coalesce(goods_total, 0) / 20.0)::integer))
    into v_weight, v_space
    from public.orders
    where id = p_order_id;
  end if;

  update public.orders
  set
    estimated_weight_kg = coalesce(v_weight, 0),
    estimated_space_units = coalesce(v_space, 0),
    estimated_bag_count = greatest(1, ceil(coalesce(v_space, 0) / 20.0)::integer)
  where id = p_order_id;
end;
$$;

create or replace function public.recalculate_order_capacity_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recalculate_order_capacity(old.order_id);
    return old;
  end if;

  perform public.recalculate_order_capacity(new.order_id);
  return new;
end;
$$;

drop trigger if exists recalculate_order_capacity on public.order_items;
create trigger recalculate_order_capacity
after insert or update or delete
on public.order_items
for each row
execute function public.recalculate_order_capacity_trigger();

-- If a product's estimated dimensions change, re-check every open
-- order containing that product and repack only when necessary.
create or replace function public.recalculate_product_orders_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
begin
  if new.estimated_weight_kg is distinct from old.estimated_weight_kg
     or new.space_units is distinct from old.space_units
     or new.handling_type is distinct from old.handling_type then
    for v_order_id in
      select distinct oi.order_id
      from public.order_items oi
      where oi.product_id = new.id
    loop
      perform public.recalculate_order_capacity(v_order_id);
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists recalculate_product_orders on public.products;
create trigger recalculate_product_orders
after update of estimated_weight_kg, space_units, handling_type
on public.products
for each row
execute function public.recalculate_product_orders_trigger();

-- Calculate all existing mock orders now.
do $$
declare
  v_order_id uuid;
begin
  for v_order_id in select id from public.orders loop
    perform public.recalculate_order_capacity(v_order_id);
  end loop;
end;
$$;

-- ---------------------------------------------------------
-- CREATE STANDARD RUNS
-- Generates real rows for each active driver's primary area.
-- ---------------------------------------------------------

create or replace function public.create_delivery_runs_for_date(p_date date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver record;
  v_slot timestamptz;
  v_start_hour integer := 8;
  v_end_hour integer := 20;
  v_interval_minutes integer := 120;
  v_inserted integer := 0;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher')
     and auth.uid() is not null then
    raise exception 'Not authorised to create delivery runs';
  end if;

  select coalesce((value #>> '{}')::integer, 8)
  into v_start_hour
  from public.app_settings
  where key = 'run_start_hour';

  select coalesce((value #>> '{}')::integer, 20)
  into v_end_hour
  from public.app_settings
  where key = 'run_end_hour';

  select coalesce((value #>> '{}')::integer, 120)
  into v_interval_minutes
  from public.app_settings
  where key = 'run_interval_minutes';

  for v_driver in
    select distinct on (d.id)
      d.id,
      d.maximum_orders,
      d.max_weight_kg,
      d.max_space_units,
      z.town as area_name
    from public.drivers d
    join public.driver_zones dz
      on dz.driver_id = d.id
     and dz.primary_zone = true
    join public.delivery_zones z
      on z.id = dz.zone_id
    where d.active = true
    order by d.id, z.name
  loop
    for v_slot in
      select generate_series(
        make_timestamptz(
          extract(year from p_date)::integer,
          extract(month from p_date)::integer,
          extract(day from p_date)::integer,
          v_start_hour,
          0,
          0,
          'Africa/Johannesburg'
        ),
        make_timestamptz(
          extract(year from p_date)::integer,
          extract(month from p_date)::integer,
          extract(day from p_date)::integer,
          v_end_hour,
          0,
          0,
          'Africa/Johannesburg'
        ) - make_interval(mins => v_interval_minutes),
        make_interval(mins => v_interval_minutes)
      )
    loop
      insert into public.delivery_runs (
        run_code,
        area_name,
        driver_id,
        slot_start,
        slot_end,
        status,
        max_orders,
        max_weight_kg,
        max_space_units
      )
      values (
        upper(left(v_driver.area_name, 3)) || '-' ||
          to_char(v_slot at time zone 'Africa/Johannesburg', 'YYYYMMDD-HH24MI') || '-' ||
          left(v_driver.id::text, 4),
        v_driver.area_name,
        v_driver.id,
        v_slot,
        v_slot + make_interval(mins => v_interval_minutes),
        'planned',
        v_driver.maximum_orders,
        v_driver.max_weight_kg,
        v_driver.max_space_units
      )
      on conflict (driver_id, slot_start) do nothing;

      if found then
        v_inserted := v_inserted + 1;
      end if;
    end loop;
  end loop;

  return v_inserted;
end;
$$;

-- ---------------------------------------------------------
-- BALANCED TETRIS PACKING
-- Earliest slot first, then the driver bucket with the lowest
-- resulting load percentage. Mum still controls stop order.
-- ---------------------------------------------------------

create or replace function public.auto_pack_order(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_run record;
  v_next_stop integer;
begin
  perform public.recalculate_order_capacity(p_order_id);

  select *
  into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    return null;
  end if;

  if v_order.delivery_run_id is not null then
    -- Re-check the entire bucket whenever an item's size or weight changes.
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
      ) usage on true
      where r.id = v_order.delivery_run_id
        and usage.order_count <= r.max_orders
        and usage.used_weight <= r.max_weight_kg
        and usage.used_space <= r.max_space_units
    ) then
      return v_order.delivery_run_id;
    end if;

    update public.orders
    set
      delivery_run_id = null,
      assigned_driver_id = null,
      stop_sequence = null,
      scheduled_at = null,
      scheduling_note = 'Removed automatically because the bucket became over capacity'
    where id = p_order_id;

    v_order.delivery_run_id := null;
  end if;

  if v_order.payment_status <> 'paid'
     or v_order.human_help_required = true
     or v_order.delivery_zone_id is null
     or v_order.status not in ('paid', 'shopping', 'packing', 'ready') then
    update public.orders
    set scheduling_note = case
      when v_order.payment_status <> 'paid' then 'Waiting for payment before scheduling'
      when v_order.human_help_required then 'Waiting for human query to be resolved'
      when v_order.delivery_zone_id is null then 'Waiting for delivery area'
      else 'Not eligible for scheduling'
    end
    where id = p_order_id;
    return null;
  end if;

  select
    r.id,
    r.driver_id,
    r.slot_start,
    r.slot_end,
    usage.order_count,
    usage.used_weight,
    usage.used_space
  into v_run
  from public.delivery_runs r
  join public.drivers d
    on d.id = r.driver_id
   and d.active = true
  join lateral (
    select
      count(o.id)::integer as order_count,
      coalesce(sum(o.estimated_weight_kg), 0)::numeric as used_weight,
      coalesce(sum(o.estimated_space_units), 0)::integer as used_space
    from public.orders o
    where o.delivery_run_id = r.id
      and o.status <> 'cancelled'
  ) usage on true
  where r.status in ('planned', 'open')
    and r.slot_start >= now() - interval '15 minutes'
    and exists (
      select 1
      from public.driver_zones dz
      where dz.driver_id = r.driver_id
        and dz.zone_id = v_order.delivery_zone_id
    )
    and usage.order_count + 1 <= r.max_orders
    and usage.used_weight + v_order.estimated_weight_kg <= r.max_weight_kg
    and usage.used_space + v_order.estimated_space_units <= r.max_space_units
  order by
    r.slot_start asc,
    greatest(
      (usage.used_space + v_order.estimated_space_units)::numeric / r.max_space_units,
      (usage.used_weight + v_order.estimated_weight_kg)::numeric / r.max_weight_kg,
      (usage.order_count + 1)::numeric / r.max_orders
    ) asc,
    (r.max_space_units - (usage.used_space + v_order.estimated_space_units)) asc,
    (r.max_weight_kg - (usage.used_weight + v_order.estimated_weight_kg)) asc
  limit 1
  for update of r skip locked;

  if not found then
    update public.orders
    set scheduling_note = 'Waiting for the next available run'
    where id = p_order_id;
    return null;
  end if;

  select coalesce(max(stop_sequence), 0) + 1
  into v_next_stop
  from public.orders
  where delivery_run_id = v_run.id
    and status <> 'cancelled';

  update public.orders
  set
    delivery_run_id = v_run.id,
    assigned_driver_id = v_run.driver_id,
    delivery_slot_start = v_run.slot_start,
    delivery_slot_end = v_run.slot_end,
    stop_sequence = v_next_stop,
    scheduled_at = now(),
    scheduling_note = 'Automatically packed into the earliest suitable driver bucket'
  where id = p_order_id;

  return v_run.id;
end;
$$;

-- Re-run packing when item dimensions or quantities change.
create or replace function public.auto_pack_order_items_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.auto_pack_order(old.order_id);
    return old;
  end if;

  perform public.auto_pack_order(new.order_id);
  return new;
end;
$$;

drop trigger if exists auto_pack_after_order_items on public.order_items;
create trigger auto_pack_after_order_items
after insert or update or delete
on public.order_items
for each row
execute function public.auto_pack_order_items_trigger();

create or replace function public.auto_pack_product_orders_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
begin
  if new.estimated_weight_kg is distinct from old.estimated_weight_kg
     or new.space_units is distinct from old.space_units
     or new.handling_type is distinct from old.handling_type then
    for v_order_id in
      select distinct oi.order_id
      from public.order_items oi
      where oi.product_id = new.id
    loop
      perform public.auto_pack_order(v_order_id);
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists auto_pack_after_product_capacity_change on public.products;
create trigger auto_pack_after_product_capacity_change
after update of estimated_weight_kg, space_units, handling_type
on public.products
for each row
execute function public.auto_pack_product_orders_trigger();

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
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to pack delivery runs';
  end if;

  perform public.create_delivery_runs_for_date(v_today);
  perform public.create_delivery_runs_for_date(v_today + 1);

  for v_order in
    select id
    from public.orders
    where delivery_run_id is null
      and payment_status = 'paid'
      and human_help_required = false
      and delivery_zone_id is not null
      and status in ('paid', 'shopping', 'packing', 'ready')
    order by
      priority desc,
      estimated_space_units desc,
      estimated_weight_kg desc,
      created_at asc
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

-- Automatically attempt packing when an order becomes eligible.
create or replace function public.auto_pack_order_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.delivery_run_id is null
     and new.payment_status = 'paid'
     and new.human_help_required = false
     and new.delivery_zone_id is not null
     and new.status in ('paid', 'shopping', 'packing', 'ready') then
    perform public.auto_pack_order(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists auto_pack_eligible_order on public.orders;
create trigger auto_pack_eligible_order
after insert or update of payment_status, human_help_required, delivery_zone_id, status
on public.orders
for each row
execute function public.auto_pack_order_trigger();

-- ---------------------------------------------------------
-- MANUAL STOP ORDER
-- Mum controls which customer is first, second, third, etc.
-- ---------------------------------------------------------

create or replace function public.reorder_delivery_run(
  p_run_id uuid,
  p_order_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to reorder delivery runs';
  end if;

  update public.orders o
  set stop_sequence = ordered.position
  from (
    select order_id, ordinality::integer as position
    from unnest(p_order_ids) with ordinality as x(order_id, ordinality)
  ) ordered
  where o.id = ordered.order_id
    and o.delivery_run_id = p_run_id;
end;
$$;

-- ---------------------------------------------------------
-- SHOP PICKUP STOPS
-- The system derives which shops a run needs from its orders.
-- Mum may change the order of those shop stops.
-- ---------------------------------------------------------

create or replace function public.sync_delivery_run_pickups(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_sequence integer;
begin
  if p_run_id is null then
    return;
  end if;

  select coalesce(max(pickup_sequence), 0)
  into v_max_sequence
  from public.delivery_run_pickups
  where delivery_run_id = p_run_id;

  with needed_shops as (
    select distinct oi.shop_id
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    where o.delivery_run_id = p_run_id
      and o.status <> 'cancelled'
      and oi.shop_id is not null
  ), missing_shops as (
    select
      ns.shop_id,
      row_number() over (order by s.name)::integer as new_position
    from needed_shops ns
    join public.shops s on s.id = ns.shop_id
    where not exists (
      select 1
      from public.delivery_run_pickups rp
      where rp.delivery_run_id = p_run_id
        and rp.shop_id = ns.shop_id
    )
  )
  insert into public.delivery_run_pickups (
    delivery_run_id,
    shop_id,
    pickup_sequence
  )
  select
    p_run_id,
    shop_id,
    v_max_sequence + new_position
  from missing_shops
  on conflict (delivery_run_id, shop_id) do nothing;

  delete from public.delivery_run_pickups rp
  where rp.delivery_run_id = p_run_id
    and not exists (
      select 1
      from public.orders o
      join public.order_items oi on oi.order_id = o.id
      where o.delivery_run_id = p_run_id
        and o.status <> 'cancelled'
        and oi.shop_id = rp.shop_id
    );

  update public.delivery_run_pickups p
  set pickup_sequence = ordered.position
  from (
    select id, row_number() over (order by pickup_sequence, created_at, id)::integer as position
    from public.delivery_run_pickups
    where delivery_run_id = p_run_id
  ) ordered
  where p.id = ordered.id;
end;
$$;

create or replace function public.normalize_delivery_run_stops(p_run_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders o
  set stop_sequence = ordered.position
  from (
    select id, row_number() over (order by stop_sequence nulls last, created_at, id)::integer as position
    from public.orders
    where delivery_run_id = p_run_id
      and status <> 'cancelled'
  ) ordered
  where o.id = ordered.id;
$$;

create or replace function public.sync_run_pickups_from_order_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.sync_delivery_run_pickups(old.delivery_run_id);
    perform public.normalize_delivery_run_stops(old.delivery_run_id);
    return old;
  end if;

  if old.delivery_run_id is distinct from new.delivery_run_id then
    perform public.sync_delivery_run_pickups(old.delivery_run_id);
    perform public.sync_delivery_run_pickups(new.delivery_run_id);
    perform public.normalize_delivery_run_stops(old.delivery_run_id);
    perform public.normalize_delivery_run_stops(new.delivery_run_id);
  elsif old.status is distinct from new.status then
    perform public.sync_delivery_run_pickups(new.delivery_run_id);
    perform public.normalize_delivery_run_stops(new.delivery_run_id);
  end if;
  return new;
end;
$$;

drop trigger if exists sync_run_pickups_from_order on public.orders;
create trigger sync_run_pickups_from_order
after update of delivery_run_id, status or delete
on public.orders
for each row
execute function public.sync_run_pickups_from_order_trigger();

create or replace function public.sync_run_pickups_from_item_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_run_id uuid;
begin
  if tg_op = 'DELETE' then
    v_order_id := old.order_id;
  else
    v_order_id := new.order_id;
  end if;

  select delivery_run_id
  into v_run_id
  from public.orders
  where id = v_order_id;

  perform public.sync_delivery_run_pickups(v_run_id);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_run_pickups_from_item on public.order_items;
create trigger sync_run_pickups_from_item
after insert or update of shop_id or delete
on public.order_items
for each row
execute function public.sync_run_pickups_from_item_trigger();

create or replace function public.reorder_delivery_run_pickups(
  p_run_id uuid,
  p_pickup_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to reorder pickup stops';
  end if;

  update public.delivery_run_pickups p
  set pickup_sequence = ordered.position
  from (
    select pickup_id, ordinality::integer as position
    from unnest(p_pickup_ids) with ordinality as x(pickup_id, ordinality)
  ) ordered
  where p.id = ordered.pickup_id
    and p.delivery_run_id = p_run_id;
end;
$$;

revoke all on function public.create_delivery_runs_for_date(date) from public, anon, authenticated;
revoke all on function public.auto_pack_order(uuid) from public, anon, authenticated;
revoke all on function public.auto_pack_waiting_orders() from public, anon, authenticated;
revoke all on function public.reorder_delivery_run(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.reorder_delivery_run_pickups(uuid, uuid[]) from public, anon, authenticated;

grant execute on function public.create_delivery_runs_for_date(date) to authenticated;
grant execute on function public.auto_pack_waiting_orders() to authenticated;
grant execute on function public.reorder_delivery_run(uuid, uuid[]) to authenticated;
grant execute on function public.reorder_delivery_run_pickups(uuid, uuid[]) to authenticated;

-- Give the fictional testing shops map positions. Real shop
-- coordinates can be edited later in the shops table.
update public.shops
set
  latitude = case name
    when 'OK Villiers' then -27.032600
    when 'Usave Villiers' then -27.030900
    when 'Getit Test Pharmacy' then -27.029900
    when 'Getit Test Hardware' then -27.034100
    else latitude
  end,
  longitude = case name
    when 'OK Villiers' then 28.601200
    when 'Usave Villiers' then 28.598700
    when 'Getit Test Pharmacy' then 28.602100
    when 'Getit Test Hardware' then 28.596900
    else longitude
  end
where name in ('OK Villiers', 'Usave Villiers', 'Getit Test Pharmacy', 'Getit Test Hardware');

-- ---------------------------------------------------------
-- MAP-READY MOCK PINS
-- These are fictional test points around Villiers and
-- Qwalabotjha. Real orders will use WhatsApp live-location
-- latitude and longitude instead.
-- ---------------------------------------------------------

update public.orders
set
  delivery_latitude = case order_number
    when 'GET-1001' then -27.039800
    when 'GET-1002' then -27.043300
    when 'GET-1003' then -27.031000
    when 'GET-1004' then -27.046900
    when 'GET-1005' then -27.027600
    when 'GET-1006' then -27.050100
    else delivery_latitude
  end,
  delivery_longitude = case order_number
    when 'GET-1001' then 28.607500
    when 'GET-1002' then 28.611200
    when 'GET-1003' then 28.598800
    when 'GET-1004' then 28.614600
    when 'GET-1005' then 28.603000
    when 'GET-1006' then 28.617000
    else delivery_longitude
  end
where order_number in ('GET-1001', 'GET-1002', 'GET-1003', 'GET-1004', 'GET-1005', 'GET-1006');

-- Create today and tomorrow's runs, then pack eligible orders.
select public.create_delivery_runs_for_date((now() at time zone 'Africa/Johannesburg')::date);
select public.create_delivery_runs_for_date((now() at time zone 'Africa/Johannesburg')::date + 1);
select * from public.auto_pack_waiting_orders();

do $$
declare
  v_run_id uuid;
begin
  for v_run_id in select id from public.delivery_runs loop
    perform public.sync_delivery_run_pickups(v_run_id);
  end loop;
end;
$$;

-- ---------------------------------------------------------
-- AUTOMATION EVENTS FOR RUN ASSIGNMENT
-- ---------------------------------------------------------

create or replace function public.queue_getit_run_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.delivery_run_id is distinct from old.delivery_run_id then
    insert into public.automation_events (event_type, order_id, driver_id, payload)
    values (
      case when new.delivery_run_id is null then 'run_unassigned' else 'run_assigned' end,
      new.id,
      new.assigned_driver_id,
      jsonb_build_object(
        'order_number', new.order_number,
        'delivery_run_id', new.delivery_run_id,
        'stop_sequence', new.stop_sequence,
        'delivery_slot_start', new.delivery_slot_start,
        'delivery_slot_end', new.delivery_slot_end,
        'estimated_weight_kg', new.estimated_weight_kg,
        'estimated_space_units', new.estimated_space_units,
        'estimated_bag_count', new.estimated_bag_count
      )
    );
  elsif new.stop_sequence is distinct from old.stop_sequence then
    insert into public.automation_events (event_type, order_id, driver_id, payload)
    values (
      'stop_sequence_changed',
      new.id,
      new.assigned_driver_id,
      jsonb_build_object(
        'order_number', new.order_number,
        'delivery_run_id', new.delivery_run_id,
        'stop_sequence', new.stop_sequence
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists queue_getit_run_event on public.orders;
create trigger queue_getit_run_event
after update of delivery_run_id, stop_sequence
on public.orders
for each row
execute function public.queue_getit_run_event();

-- ---------------------------------------------------------
-- SECURITY + REALTIME
-- ---------------------------------------------------------

alter table public.delivery_runs enable row level security;
alter table public.delivery_run_pickups enable row level security;
grant select, insert, update, delete on public.delivery_runs to authenticated;
grant select, insert, update, delete on public.delivery_run_pickups to authenticated;

drop policy if exists "owner and admin full access" on public.delivery_runs;
create policy "owner and admin full access"
on public.delivery_runs
for all
to authenticated
using ((select public.current_staff_role()) in ('owner', 'admin'))
with check ((select public.current_staff_role()) in ('owner', 'admin'));

drop policy if exists "owner and admin full access" on public.delivery_run_pickups;
create policy "owner and admin full access"
on public.delivery_run_pickups
for all
to authenticated
using ((select public.current_staff_role()) in ('owner', 'admin'))
with check ((select public.current_staff_role()) in ('owner', 'admin'));

-- Dispatcher support can be enabled later without changing
-- the owner/admin behaviour already in production.

do $$
declare
  table_name text;
begin
  foreach table_name in array array['delivery_runs', 'delivery_run_pickups', 'shops']
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;

-- Final confirmation.
select
  (select count(*) from public.delivery_runs) as delivery_runs,
  (select count(*) from public.orders where delivery_run_id is not null) as packed_orders,
  (select count(*) from public.orders where delivery_run_id is null and status not in ('delivered', 'cancelled')) as waiting_orders;
