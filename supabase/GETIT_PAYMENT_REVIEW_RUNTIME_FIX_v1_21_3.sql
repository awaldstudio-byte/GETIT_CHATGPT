-- Fixes two runtime failures in approve_payment_review:
-- 1. COALESCE/NULLIF are SQL special forms and cannot be schema-qualified.
-- 2. orders.order_total is generated and must not be assigned directly.

create or replace function public.approve_payment_review(
  p_order_id uuid,
  p_review_note text default null::text
)
returns table(
  payment_review_id uuid,
  approved_goods_total numeric,
  approved_order_total numeric
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_order public.orders%rowtype;
  v_review_id uuid;
  v_goods_total numeric(12,2);
  v_delivery_fee numeric(12,2) := 0;
  v_total numeric(12,2);
  v_items jsonb;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to approve payment reviews';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then raise exception 'Order not found'; end if;

  if not exists (
    select 1 from public.order_items where order_id = p_order_id
  ) then
    raise exception 'The order has no item lines to approve';
  end if;

  if exists (
    select 1
    from public.order_items
    where order_id = p_order_id and review_unit_price is null
  ) then
    raise exception 'Every order item needs a reviewed price before approval';
  end if;

  select pg_catalog.round(
    coalesce(pg_catalog.sum(quantity * review_unit_price), 0::numeric),
    2
  )
  into v_goods_total
  from public.order_items
  where order_id = p_order_id;

  v_delivery_fee := coalesce(
    nullif(pg_catalog.to_jsonb(v_order) ->> 'delivery_fee', '')::numeric,
    0::numeric
  );
  v_total := pg_catalog.round(v_goods_total + v_delivery_fee, 2);

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'order_item_id', oi.id,
      'product_id', oi.product_id,
      'shop_id', oi.shop_id,
      'quantity', oi.quantity,
      'unit_price', oi.review_unit_price,
      'line_total', pg_catalog.round(oi.quantity * oi.review_unit_price, 2)
    )
    order by oi.id
  )
  into v_items
  from public.order_items oi
  where oi.order_id = p_order_id;

  insert into public.payment_reviews (
    order_id, status, approved_goods_total, approved_order_total,
    review_note, approved_at, approved_by
  )
  values (
    p_order_id, 'link_requested', v_goods_total, v_total,
    p_review_note, pg_catalog.now(), auth.uid()
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
    reviewed_at = coalesce(reviewed_at, pg_catalog.now()),
    reviewed_by = coalesce(reviewed_by, auth.uid())
  where order_id = p_order_id;

  update public.orders
  set
    goods_total = v_goods_total,
    updated_at = pg_catalog.now()
  where id = p_order_id;

  insert into public.automation_events (event_type, order_id, payload)
  values (
    'payment_link_requested',
    p_order_id,
    pg_catalog.jsonb_build_object(
      'order_number', v_order.order_number,
      'approved_goods_total', v_goods_total,
      'delivery_fee', v_delivery_fee,
      'approved_order_total', v_total,
      'pricing_policy_version', 'villiers_flat_delivery_v1',
      'items', coalesce(v_items, '[]'::jsonb),
      'approved_by', auth.uid()
    )
  );

  payment_review_id := v_review_id;
  approved_goods_total := v_goods_total;
  approved_order_total := v_total;
  return next;
end;
$function$;
