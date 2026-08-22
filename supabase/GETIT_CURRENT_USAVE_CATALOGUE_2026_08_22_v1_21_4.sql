-- Current Gauteng regional Usave flyer reviewed on 2026-08-22.
-- These are advertised prices only. Villiers stock and till pricing remain
-- subject to staff confirmation before a real payment request.

do $$
declare
  v_source_id uuid;
begin
  select id into v_source_id
  from public.catalogue_sources
  where source_url = 'https://www.kimbino.co.za/usave/usave-gauteng-specials-from-tuesday-11-08-2026-5501604/'
  order by created_at desc
  limit 1;

  if v_source_id is null then
    insert into public.catalogue_sources (
      id, shop_id, source_type, title, source_url, region,
      valid_from, valid_to, retrieved_at, local_copy_path,
      villiers_comparison_status, active, notes
    ) values (
      gen_random_uuid(),
      '10000000-0000-0000-0000-000000000002',
      'flyer',
      'Usave Gauteng Specials — 11 to 23 August 2026',
      'https://www.kimbino.co.za/usave/usave-gauteng-specials-from-tuesday-11-08-2026-5501604/',
      'Gauteng regional online flyer — provisional for Usave Villiers',
      date '2026-08-11',
      date '2026-08-23',
      now(),
      null,
      'pending',
      true,
      'Operator reviewed the current online flyer pages on 2026-08-22. Advertised regional prices only; physical Villiers stock and till price require staff confirmation during fulfilment.'
    )
    returning id into v_source_id;
  else
    update public.catalogue_sources
    set title = 'Usave Gauteng Specials — 11 to 23 August 2026',
        region = 'Gauteng regional online flyer — provisional for Usave Villiers',
        valid_from = date '2026-08-11',
        valid_to = date '2026-08-23',
        retrieved_at = now(),
        active = true,
        villiers_comparison_status = 'pending',
        notes = 'Operator reviewed the current online flyer pages on 2026-08-22. Advertised regional prices only; physical Villiers stock and till price require staff confirmation during fulfilment.',
        updated_at = now()
    where id = v_source_id;
  end if;

  update public.shop_prices
  set special_price = 31.99,
      special_starts = date '2026-08-11',
      special_ends = date '2026-08-23',
      in_stock = true,
      approved = true,
      source = 'Usave Gauteng Specials — 11 to 23 August 2026',
      last_checked = now(),
      notes = 'Current regional flyer price. Advertised only; physical Villiers stock and till price require staff confirmation before payment.',
      source_id = v_source_id,
      regional_scope = 'regional',
      local_verification_status = 'operator_approved_temporary',
      advertised_only = true,
      updated_at = now()
  where id = 'f35dfa3b-df60-473e-8fb4-589970d0dc1b';

  update public.shop_prices
  set special_price = 89.99,
      special_starts = date '2026-08-11',
      special_ends = date '2026-08-23',
      in_stock = true,
      approved = true,
      source = 'Usave Gauteng Specials — 11 to 23 August 2026',
      last_checked = now(),
      notes = 'Current regional flyer price. Advertised only; physical Villiers stock and till price require staff confirmation before payment.',
      source_id = v_source_id,
      regional_scope = 'regional',
      local_verification_status = 'operator_approved_temporary',
      advertised_only = true,
      updated_at = now()
  where id = 'a2728c03-938c-41c2-bbc3-e9ebd1dd5e27';
end $$;
