-- Run after v1.4.1, v1.5 and v1.6 in that order.

-- 1. No fixed, empty all-day slots.
select count(*) as empty_open_runs
from public.delivery_runs r
where r.status in ('planned', 'open')
  and not exists (
    select 1 from public.orders o
    where o.delivery_run_id = r.id and o.status <> 'cancelled'
  );

-- 2. Driver board is one row per driver, grouped by name.
select driver_name, effective_status, run_status, order_count,
       window_started_at, window_expires_at, load_ratio
from public.driver_control_board
order by driver_name;

-- 3. Payment requests preserve their correct stages.
select order_number, status, item_lines, all_prices_verified,
       reviewed_goods_total, delivery_fee, second_shop_fee,
       priority_fee, approved_order_total, waiting_seconds
from public.payment_review_queue
order by requested_at;

-- 4. Every order visible to the Control Centre.
select order_number, customer_name, driver_name, payment_status,
       payment_review_status, location_quality, item_lines, order_total
from public.control_centre_orders
order by created_at desc;

-- 5. Realtime coverage.
select required.table_name,
       exists (
         select 1 from pg_publication_tables p
         where p.pubname = 'supabase_realtime'
           and p.schemaname = 'public'
           and p.tablename = required.table_name
       ) as realtime_enabled
from unnest(array[
  'orders','order_items','drivers','driver_sessions','delivery_runs',
  'delivery_run_pickups','payment_reviews','support_queries','shops'
]) as required(table_name)
order by required.table_name;

-- 6. Pin quality: mock/imported pins must not report confirmed.
select location_quality, count(*)
from public.map_order_pins
group by location_quality
order by location_quality;
