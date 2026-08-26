-- Getit catalogue Villiers-time expiry hardening v1.22.1
-- Specials expire on the local Villiers business date, not UTC current_date.

create or replace view public.catalogue_public_rows
with (security_invoker=true)
as
 SELECT s.id AS shop_id,
    s.name AS shop_name,
    s.town,
    p.id AS product_id,
    p.name AS product_name,
    p.brand,
    p.size,
    p.category,
    p.search_aliases,
    p.barcode AS product_barcode,
    p.bulky,
    p.maximum_units,
    p.estimated_weight_kg,
    p.space_units,
    p.handling_type,
    sp.normal_price,
        CASE
            WHEN sp.special_price IS NOT NULL AND sp.special_starts IS NOT NULL AND sp.special_ends IS NOT NULL AND ((now() at time zone 'Africa/Johannesburg')::date) >= sp.special_starts AND ((now() at time zone 'Africa/Johannesburg')::date) <= sp.special_ends THEN sp.special_price
            ELSE NULL::numeric
        END AS current_special_price,
        CASE
            WHEN sp.special_price IS NOT NULL AND sp.special_starts IS NOT NULL AND sp.special_ends IS NOT NULL AND ((now() at time zone 'Africa/Johannesburg')::date) >= sp.special_starts AND ((now() at time zone 'Africa/Johannesburg')::date) <= sp.special_ends THEN sp.special_starts
            ELSE NULL::date
        END AS current_special_starts,
        CASE
            WHEN sp.special_price IS NOT NULL AND sp.special_starts IS NOT NULL AND sp.special_ends IS NOT NULL AND ((now() at time zone 'Africa/Johannesburg')::date) >= sp.special_starts AND ((now() at time zone 'Africa/Johannesburg')::date) <= sp.special_ends THEN sp.special_ends
            ELSE NULL::date
        END AS current_special_ends,
        CASE
            WHEN sp.special_price IS NOT NULL AND sp.special_starts IS NOT NULL AND sp.special_ends IS NOT NULL AND ((now() at time zone 'Africa/Johannesburg')::date) >= sp.special_starts AND ((now() at time zone 'Africa/Johannesburg')::date) <= sp.special_ends THEN sp.special_price
            ELSE sp.normal_price
        END AS effective_price,
    sp.in_stock,
    sp.source,
    cs.source_url,
    cs.region AS source_region,
    sp.last_checked,
    sp.notes,
    sp.regional_scope,
    sp.local_verification_status,
    sp.advertised_only,
    COALESCE(sp.barcode, p.barcode) AS barcode,
    sp.shop_sku
   FROM public.shop_prices sp
     JOIN public.shops s ON s.id = sp.shop_id
     JOIN public.products p ON p.id = sp.product_id
     LEFT JOIN public.catalogue_sources cs ON cs.id = sp.source_id
  WHERE s.active = true AND p.active = true AND sp.approved = true AND sp.local_verification_status <> 'rejected'::text AND COALESCE(sp.source, ''::text) !~* '^mock'::text AND (sp.normal_price IS NOT NULL OR sp.special_price IS NOT NULL AND sp.special_starts IS NOT NULL AND sp.special_ends IS NOT NULL AND ((now() at time zone 'Africa/Johannesburg')::date) >= sp.special_starts AND ((now() at time zone 'Africa/Johannesburg')::date) <= sp.special_ends);

CREATE OR REPLACE FUNCTION public.get_messaging_grounding(p_query text, p_limit integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_business_date date := (now() at time zone 'Africa/Johannesburg')::date;
  v_query text := lower(trim(coalesce(p_query, '')));
  v_tokens text[] := '{}'::text[];
  v_active_public_rows integer := 0;
  v_reference_rows integer := 0;
  v_price_quotable_rows integer := 0;
  v_valid_through date;
  v_last_checked timestamptz;
  v_matches jsonb := '[]'::jsonb;
begin
  perform private.assert_messaging_service_role();

  if p_limit not between 1 and 25 then
    raise exception 'invalid grounding result limit' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct token), '{}'::text[])
  into v_tokens
  from regexp_split_to_table(v_query, '[^a-z0-9]+') token
  where length(token) >= 3
    and token not in (
      'the','and','for','with','from','that','this','what','when','where','which',
      'some','please','want','need','order','buy','get','add','make','cook','recipe',
      'deliver','delivery','villiers','bestie','today','tonight','dinner'
    );

  select count(*) into v_active_public_rows
  from public.catalogue_public_rows;

  select
    count(*),
    max(sp.special_ends) filter (where sp.special_starts is not null and sp.special_ends is not null and v_business_date between sp.special_starts and sp.special_ends),
    max(sp.last_checked),
    count(*) filter (
      where sp.local_verification_status in ('verified', 'operator_approved_temporary')
        and (
          sp.normal_price is not null
          or (
            sp.special_price is not null
            and sp.special_starts is not null
            and sp.special_ends is not null
            and v_business_date between sp.special_starts and sp.special_ends
          )
        )
    )
  into v_reference_rows, v_valid_through, v_last_checked, v_price_quotable_rows
  from public.shop_prices sp
  join public.shops s on s.id = sp.shop_id
  join public.products p on p.id = sp.product_id
  where s.active = true
    and p.active = true
    and sp.approved = true
    and sp.local_verification_status <> 'rejected'
    and coalesce(sp.source, '') !~* '^mock';

  if cardinality(v_tokens) > 0 then
    with eligible as (
      select
        p.id as product_id,
        p.name as product_name,
        p.brand,
        p.size,
        p.category,
        s.id as shop_id,
        s.name as shop_name,
        sp.special_price,
        sp.special_starts,
        sp.special_ends,
        sp.normal_price,
        sp.local_verification_status,
        sp.advertised_only,
        cs.source_url,
        lower(concat_ws(' ', p.name, p.brand, p.size, p.category, s.name, array_to_string(p.search_aliases, ' '))) as search_blob
      from public.shop_prices sp
      join public.shops s on s.id = sp.shop_id
      join public.products p on p.id = sp.product_id
      left join public.catalogue_sources cs on cs.id = sp.source_id
      where s.active = true
        and p.active = true
        and sp.approved = true
        and sp.local_verification_status <> 'rejected'
        and coalesce(sp.source, '') !~* '^mock'
    ),
    scored as (
      select
        e.*,
        (
          select count(*)::integer
          from unnest(v_tokens) token
          where e.search_blob like '%' || token || '%'
        ) as match_score,
        (
          e.local_verification_status in ('verified', 'operator_approved_temporary')
          and (
            e.normal_price is not null
            or (
              e.special_price is not null
              and e.special_starts is not null
              and e.special_ends is not null
              and v_business_date between e.special_starts and e.special_ends
            )
          )
        ) as price_verified,
        (
          e.special_price is not null
          and e.special_starts is not null
          and e.special_ends is not null
          and v_business_date between e.special_starts and e.special_ends
        ) as special_current
      from eligible e
    ),
    chosen as (
      select *
      from scored
      where match_score > 0
      order by match_score desc, product_name, shop_name
      limit p_limit
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', product_id,
      'product_name', product_name,
      'brand', brand,
      'size', size,
      'category', category,
      'shop_id', shop_id,
      'shop_name', shop_name,
      'match_score', match_score,
      'reference_only', not price_verified,
      'price_verified', price_verified,
      'effective_price', case
        when price_verified and special_current then special_price
        when price_verified then normal_price
        else null
      end,
      'price_kind', case
        when price_verified and special_current then 'special'
        when price_verified and normal_price is not null then 'normal'
        else null
      end,
      'price_valid_through', case when price_verified and special_current then special_ends else null end,
      'operator_approved_temporary', local_verification_status = 'operator_approved_temporary',
      'advertised_only', advertised_only,
      'source_url', source_url,
      'stock_verified', false
    ) order by match_score desc, product_name, shop_name), '[]'::jsonb)
    into v_matches
    from chosen;
  end if;

  return jsonb_build_object(
    'service_area', jsonb_build_object(
      'launch_town', 'Villiers',
      'normal_orders_outside_launch_town', false,
      'outside_area_requires_human', true
    ),
    'catalogue', jsonb_build_object(
      'business_timezone', 'Africa/Johannesburg',
      'business_date', v_business_date,
      'active_public_rows', v_active_public_rows,
      'reference_rows', v_reference_rows,
      'price_quotable_rows', v_price_quotable_rows,
      'valid_through', v_valid_through,
      'last_checked', v_last_checked,
      'current_price_quote_allowed', v_price_quotable_rows > 0,
      'current_stock_quote_allowed', false,
      'current_price_or_stock_quote_allowed', v_price_quotable_rows > 0,
      'requires_checkout_revalidation', true,
      'status', case
        when v_price_quotable_rows > 0 then 'operator_approved_current_rows'
        when v_active_public_rows > 0 then 'advisory_current_rows'
        else 'expired_or_unavailable'
      end
    ),
    'matches', v_matches,
    'rules', jsonb_build_object(
      'unlisted_items_allowed_as_price_pending', true,
      'a_match_is_not_stock_confirmation', true,
      'operator_approved_prices_may_be_quoted_until_their_valid_through_date', true,
      'do_not_claim_an_item_was_added_without_a_persisted_draft_change', true
    )
  );
end;
$function$;


revoke all on function public.get_messaging_grounding(text,integer) from public, anon, authenticated;
grant execute on function public.get_messaging_grounding(text,integer) to service_role;
