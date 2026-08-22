-- Getit messaging grounding v1.18.0
-- Supplies the orchestration layer with explicit launch-area and catalogue
-- freshness facts. Historical catalogue rows are discovery hints only: their
-- price and stock fields are deliberately excluded.

create or replace function public.get_messaging_grounding(
  p_query text,
  p_limit integer default 12
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_query text := lower(trim(coalesce(p_query, '')));
  v_tokens text[] := '{}'::text[];
  v_active_public_rows integer := 0;
  v_reference_rows integer := 0;
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

  select count(*), max(sp.special_ends), max(sp.last_checked)
  into v_reference_rows, v_valid_through, v_last_checked
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
        lower(concat_ws(' ', p.name, p.brand, p.size, p.category, s.name, array_to_string(p.search_aliases, ' '))) as search_blob
      from public.shop_prices sp
      join public.shops s on s.id = sp.shop_id
      join public.products p on p.id = sp.product_id
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
        ) as match_score
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
      'reference_only', true,
      'price_verified', false,
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
      'active_public_rows', v_active_public_rows,
      'reference_rows', v_reference_rows,
      'valid_through', v_valid_through,
      'last_checked', v_last_checked,
      'current_price_or_stock_quote_allowed', false,
      'requires_checkout_revalidation', true,
      'status', case when v_active_public_rows > 0 then 'advisory_current_rows' else 'expired_or_unavailable' end
    ),
    'matches', v_matches,
    'rules', jsonb_build_object(
      'unlisted_items_allowed_as_price_pending', true,
      'a_match_is_not_stock_confirmation', true,
      'do_not_claim_an_item_was_added_without_a_persisted_draft_change', true
    )
  );
end;
$function$;

revoke all on function public.get_messaging_grounding(text, integer)
from public, anon, authenticated;

grant execute on function public.get_messaging_grounding(text, integer)
to service_role;

insert into public.app_settings(key, value, description)
values
  (
    'messaging_grounding_version',
    to_jsonb('getit-grounding-v1-18'::text),
    'Deterministic Villiers-area and catalogue-freshness grounding used before any model decision.'
  ),
  (
    'messaging_training_source',
    to_jsonb('respondio_launch_rules_v1_1_recovered'::text),
    'Behaviour source recovered from Nathan''s original Respond.io launch-rules pack; Respond.io is not a runtime dependency.'
  )
on conflict (key) do update
set value = excluded.value,
    description = excluded.description,
    updated_at = now();
