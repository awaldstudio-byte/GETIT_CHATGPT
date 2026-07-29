-- Getit v1.12.0
-- Order-intake reliability, current fee policy, secure catalogue search,
-- and a small operator-health surface for the Control Centre.

begin;

-- Keep the proven order writer intact and put a compatibility layer in front
-- of it. This makes optional customer preferences safe without duplicating
-- the large transactional order-creation implementation.
alter function public.submit_getit_whatsapp_order(jsonb)
  rename to submit_getit_whatsapp_order_strict_v1;

revoke all on function public.submit_getit_whatsapp_order_strict_v1(jsonb)
  from public, anon, authenticated, service_role;

create function public.submit_getit_whatsapp_order(p_payload jsonb)
returns table(
  order_id uuid,
  order_number text,
  order_status text,
  payment_review_status text,
  duplicate boolean,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_payload jsonb;
  v_items jsonb;
  v_phone text;
  v_full_name text;
  v_substitution text;
  v_substitution_missing boolean;
  v_allow_substitution boolean;
  v_result record;
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'ORDER_PAYLOAD_INVALID';
  end if;

  v_payload := p_payload;
  v_phone := pg_catalog.regexp_replace(
    pg_catalog.coalesce(v_payload ->> 'phone', ''),
    '[^0-9+]',
    '',
    'g'
  );
  v_full_name := pg_catalog.nullif(pg_catalog.btrim(v_payload ->> 'full_name'), '');

  -- A name is useful, but it must never block a valid confirmed order.
  if v_full_name is null then
    select c.full_name
      into v_full_name
    from public.customers c
    where c.phone = v_phone
    limit 1;

    v_payload := pg_catalog.jsonb_set(
      v_payload,
      '{full_name}',
      pg_catalog.to_jsonb(
        pg_catalog.coalesce(
          pg_catalog.nullif(pg_catalog.btrim(v_full_name), ''),
          'WhatsApp customer'
        )
      ),
      true
    );
  end if;

  -- Defensive parsing: delivery metadata is not a product. n8n filters this
  -- too, while this guard protects every future API caller.
  if pg_catalog.jsonb_typeof(v_payload -> 'items') = 'array' then
    select pg_catalog.coalesce(
      pg_catalog.jsonb_agg(entry.item order by entry.ordinality),
      '[]'::jsonb
    )
      into v_items
    from pg_catalog.jsonb_array_elements(v_payload -> 'items')
      with ordinality as entry(item, ordinality)
    where pg_catalog.nullif(pg_catalog.btrim(entry.item ->> 'requested_text'), '') is not null
      and pg_catalog.btrim(entry.item ->> 'requested_text') !~*
        '^(deliver([[:space:]]+to|y([[:space:]]+to|[[:space:]]+address))|delivery[[:space:]]+address|address|location|landmark|house[[:space:]]+note|access|substitutions?|substitution[[:space:]]+preference|requested[[:space:]]+window|delivery[[:space:]]+window|area|shops?|order[[:space:]]+[0-9]+)[[:space:]]*:';

    v_payload := pg_catalog.jsonb_set(v_payload, '{items}', v_items, true);
  end if;

  v_substitution := pg_catalog.nullif(
    pg_catalog.btrim(v_payload ->> 'substitution_preference'),
    ''
  );
  v_substitution_missing := v_substitution is null;

  -- Safe default: continue creating the order, but never approve a replacement
  -- automatically. Staff can contact the customer only if an item is missing.
  if v_substitution_missing then
    v_substitution := 'CONTACT CUSTOMER BEFORE SUBSTITUTION';
    v_payload := pg_catalog.jsonb_set(
      v_payload,
      '{substitution_preference}',
      pg_catalog.to_jsonb(v_substitution),
      true
    );
  end if;

  v_allow_substitution :=
    not v_substitution_missing
    and v_substitution !~*
      '(no[[:space:]]+substitutions?|remove|contact|ask|check[[:space:]]+with)';

  for v_result in
    select *
    from public.submit_getit_whatsapp_order_strict_v1(v_payload)
  loop
    update public.order_items oi
    set substitution_allowed = v_allow_substitution
    where oi.order_id = v_result.order_id;

    if v_substitution_missing then
      update public.orders o
      set
        substitution_preference = null,
        draft_snapshot =
          (o.draft_snapshot - 'substitution_preference')
          || pg_catalog.jsonb_build_object(
            'substitution_preference_source',
            'not_provided_contact_before_replacing'
          )
      where o.id = v_result.order_id;
    else
      update public.orders o
      set draft_snapshot =
        o.draft_snapshot
        || pg_catalog.jsonb_build_object(
          'substitution_preference_source',
          'customer'
        )
      where o.id = v_result.order_id;
    end if;

    order_id := v_result.order_id;
    order_number := v_result.order_number;
    order_status := v_result.order_status;
    payment_review_status := v_result.payment_review_status;
    duplicate := v_result.duplicate;
    created_at := v_result.created_at;
    return next;
  end loop;
end;
$function$;

revoke all on function public.submit_getit_whatsapp_order(jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_getit_whatsapp_order(jsonb)
  to service_role;

-- An order-specific WhatsApp pin is a legitimate source. The old writer
-- already records this value, but the table constraint previously rejected it.
alter table public.orders
  drop constraint if exists orders_location_source_valid;

alter table public.orders
  add constraint orders_location_source_valid
  check (
    location_source is null
    or location_source = any (
      array[
        'whatsapp_location'::text,
        'whatsapp_live_location'::text,
        'order_specific_pin'::text,
        'control_centre'::text,
        'typed_address'::text,
        'imported'::text
      ]
    )
  );

-- Current Villiers pricing is one delivery fee per order:
-- R35 / R50 / R65. Legacy second-shop and priority columns remain for audit,
-- but are no longer charged on newly approved payment reviews.
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
set search_path = ''
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

  select *
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if not exists (
    select 1
    from public.order_items
    where order_id = p_order_id
  ) then
    raise exception 'The order has no item lines to approve';
  end if;

  if exists (
    select 1
    from public.order_items
    where order_id = p_order_id
      and review_unit_price is null
  ) then
    raise exception 'Every order item needs a reviewed price before approval';
  end if;

  select pg_catalog.round(
    pg_catalog.coalesce(pg_catalog.sum(quantity * review_unit_price), 0),
    2
  )
    into v_goods_total
  from public.order_items
  where order_id = p_order_id;

  v_delivery_fee := pg_catalog.coalesce(
    pg_catalog.nullif(
      pg_catalog.to_jsonb(v_order) ->> 'delivery_fee',
      ''
    )::numeric,
    0
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
    pg_catalog.now(),
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
    reviewed_at = pg_catalog.coalesce(reviewed_at, pg_catalog.now()),
    reviewed_by = pg_catalog.coalesce(reviewed_by, auth.uid())
  where order_id = p_order_id;

  update public.orders
  set
    goods_total = v_goods_total,
    order_total = v_total,
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
      'items', pg_catalog.coalesce(v_items, '[]'::jsonb),
      'approved_by', auth.uid()
    )
  );

  payment_review_id := v_review_id;
  approved_goods_total := v_goods_total;
  approved_order_total := v_total;
  return next;
end;
$function$;

-- The public catalogue feed is served by Edge Functions using service_role.
-- Dashboard users are authenticated; anonymous direct table access is not
-- required and should not bypass the underlying RLS policies.
alter view public.catalogue_public_rows
  set (security_invoker = true);

revoke all on public.catalogue_public_rows
  from anon, authenticated, service_role;
grant select on public.catalogue_public_rows to authenticated, service_role;

create or replace function public.search_getit_catalogue(
  p_query text default '',
  p_shop_id uuid default null,
  p_limit integer default 50
)
returns table(
  shop_id uuid,
  shop_name text,
  product_id uuid,
  product_name text,
  brand text,
  size text,
  category text,
  normal_price numeric,
  current_special_price numeric,
  current_special_ends date,
  effective_price numeric,
  in_stock boolean,
  local_verification_status text,
  last_checked timestamptz,
  source text,
  match_rank integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_query text := pg_catalog.lower(
    pg_catalog.btrim(pg_catalog.coalesce(p_query, ''))
  );
  v_limit integer := pg_catalog.least(
    pg_catalog.greatest(pg_catalog.coalesce(p_limit, 50), 1),
    100
  );
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to search the catalogue';
  end if;

  return query
  select
    c.shop_id,
    c.shop_name,
    c.product_id,
    c.product_name,
    c.brand,
    c.size,
    c.category,
    c.normal_price,
    c.current_special_price,
    c.current_special_ends,
    c.effective_price,
    c.in_stock,
    c.local_verification_status,
    c.last_checked,
    c.source,
    case
      when v_query = '' then 10
      when pg_catalog.lower(
        pg_catalog.coalesce(c.product_barcode, c.barcode, '')
      ) = v_query then 0
      when pg_catalog.lower(pg_catalog.coalesce(c.product_name, '')) = v_query then 1
      when pg_catalog.lower(pg_catalog.coalesce(c.product_name, ''))
        like v_query || '%' then 2
      when pg_catalog.lower(pg_catalog.coalesce(c.brand, ''))
        like v_query || '%' then 3
      else 4
    end as match_rank
  from public.catalogue_public_rows c
  cross join lateral (
    select pg_catalog.lower(
      pg_catalog.concat_ws(
        ' ',
        c.shop_name,
        c.product_name,
        c.brand,
        c.size,
        c.category,
        pg_catalog.array_to_string(c.search_aliases, ' '),
        c.product_barcode,
        c.barcode,
        c.shop_sku
      )
    ) as haystack
  ) search_text
  where (p_shop_id is null or c.shop_id = p_shop_id)
    and (
      v_query = ''
      or pg_catalog.strpos(search_text.haystack, v_query) > 0
    )
  order by
    16,
    c.in_stock desc,
    c.effective_price asc nulls last,
    c.shop_name,
    c.product_name
  limit v_limit;
end;
$function$;

revoke all on function public.search_getit_catalogue(text, uuid, integer)
  from public, anon;
grant execute on function public.search_getit_catalogue(text, uuid, integer)
  to authenticated;

create or replace function public.get_getit_operator_health()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_automation_backlog integer;
  v_stuck_processing integer;
  v_failed_events integer;
  v_oldest_pending timestamptz;
  v_payment_waiting integer;
  v_location_attention integer;
  v_help_waiting integer;
  v_catalogue_rows integer;
  v_catalogue_needs_check integer;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to view system health';
  end if;

  select
    pg_catalog.count(*) filter (
      where ae.status = 'pending'
        and ae.created_at < pg_catalog.now() - interval '10 minutes'
    ),
    pg_catalog.count(*) filter (
      where ae.status = 'processing'
        and ae.updated_at < pg_catalog.now() - interval '10 minutes'
    ),
    pg_catalog.count(*) filter (where ae.status = 'failed'),
    pg_catalog.min(ae.created_at) filter (where ae.status = 'pending')
  into
    v_automation_backlog,
    v_stuck_processing,
    v_failed_events,
    v_oldest_pending
  from public.automation_events ae;

  select pg_catalog.count(*)
    into v_payment_waiting
  from public.payment_reviews pr
  join public.orders o on o.id = pr.order_id
  where pr.status = 'pending_review'
    and o.human_help_required = false;

  select pg_catalog.count(*)
    into v_location_attention
  from public.orders o
  where o.status not in ('delivered', 'cancelled')
    and o.location_confirmed = false;

  select pg_catalog.count(*)
    into v_help_waiting
  from public.support_queries sq
  where sq.status = 'open';

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (
      where c.local_verification_status <> 'verified'
        or c.last_checked is null
        or c.last_checked < pg_catalog.now() - interval '14 days'
    )
  into v_catalogue_rows, v_catalogue_needs_check
  from public.catalogue_public_rows c;

  return pg_catalog.jsonb_build_object(
    'status',
      case
        when v_stuck_processing > 0
          or v_failed_events > 0
          or v_automation_backlog > 0
          then 'attention'
        else 'healthy'
      end,
    'automation_backlog', v_automation_backlog,
    'stuck_processing', v_stuck_processing,
    'failed_events', v_failed_events,
    'oldest_pending_at', v_oldest_pending,
    'payment_waiting', v_payment_waiting,
    'location_attention', v_location_attention,
    'help_waiting', v_help_waiting,
    'catalogue_rows', v_catalogue_rows,
    'catalogue_needs_check', v_catalogue_needs_check,
    'checked_at', pg_catalog.now()
  );
end;
$function$;

revoke all on function public.get_getit_operator_health()
  from public, anon;
grant execute on function public.get_getit_operator_health()
  to authenticated;

comment on function public.submit_getit_whatsapp_order(jsonb) is
  'Getit WhatsApp intake compatibility layer: optional substitution/name, metadata filtering, and safe replacement defaults.';
comment on function public.search_getit_catalogue(text, uuid, integer) is
  'Staff-only cross-shop catalogue price search for the Getit Control Centre.';
comment on function public.get_getit_operator_health() is
  'Staff-only summary of queues, location attention, catalogue freshness, and automation health.';

commit;
