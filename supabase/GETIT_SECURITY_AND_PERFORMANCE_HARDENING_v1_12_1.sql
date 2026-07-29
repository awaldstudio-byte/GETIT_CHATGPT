-- Getit v1.12.1
-- Remove anonymous access inherited from PostgreSQL's default function grants
-- and add covering indexes for the operational relationships used every day.

begin;

do $block$
declare
  v_function record;
begin
  for v_function in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
      and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    execute pg_catalog.format(
      'revoke execute on function %s from public, anon',
      v_function.signature
    );
    execute pg_catalog.format(
      'grant execute on function %s to authenticated, service_role',
      v_function.signature
    );
  end loop;
end;
$block$;

-- Fixed search paths prevent caller-controlled object resolution.
alter function public.set_updated_at()
  set search_path = 'public';
alter function public.catalogue_product_key(text, text, text)
  set search_path = 'public';
alter function public.catalogue_staging_counts_trigger()
  set search_path = 'public';

-- Cover foreign keys used in queue loading, order review and dispatch joins.
create index if not exists catalogue_sources_created_by_idx
  on public.catalogue_sources(created_by);
create index if not exists catalogue_staging_items_shop_id_idx
  on public.catalogue_staging_items(shop_id);
create index if not exists customers_delivery_zone_id_idx
  on public.customers(delivery_zone_id);
create index if not exists delivery_run_pickups_shop_id_idx
  on public.delivery_run_pickups(shop_id);
create index if not exists delivery_runs_created_by_idx
  on public.delivery_runs(created_by);
create index if not exists driver_sessions_override_by_idx
  on public.driver_sessions(override_by);
create index if not exists order_items_order_id_idx
  on public.order_items(order_id);
create index if not exists order_items_product_id_idx
  on public.order_items(product_id);
create index if not exists order_items_reviewed_by_idx
  on public.order_items(reviewed_by);
create index if not exists order_items_shop_id_idx
  on public.order_items(shop_id);
create index if not exists order_status_history_order_id_idx
  on public.order_status_history(order_id);
create index if not exists orders_assigned_driver_id_idx
  on public.orders(assigned_driver_id);
create index if not exists orders_delivery_zone_id_idx
  on public.orders(delivery_zone_id);
create index if not exists orders_location_corrected_by_idx
  on public.orders(location_corrected_by);
create index if not exists payment_reviews_approved_by_idx
  on public.payment_reviews(approved_by);
create index if not exists shops_coordinates_verified_by_idx
  on public.shops(coordinates_verified_by);
create index if not exists support_queries_resolved_by_idx
  on public.support_queries(resolved_by);

commit;
