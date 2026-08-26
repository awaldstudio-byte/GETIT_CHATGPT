-- Point all customer-facing catalogue links at the live date-filtered feed.
-- Legacy generated storage exports are intentionally no longer referenced.

insert into public.app_settings(key,value,description)
values
  ('catalogue_public_url',to_jsonb('https://uoqgbaqffmxdnenxfdjr.supabase.co/functions/v1/catalogue-feed'::text),'Live Villiers-date-filtered catalogue endpoint'),
  ('catalogue_json_url',to_jsonb('https://uoqgbaqffmxdnenxfdjr.supabase.co/functions/v1/catalogue-feed'::text),'Live Villiers-date-filtered catalogue endpoint'),
  ('catalogue_text_url',to_jsonb('https://uoqgbaqffmxdnenxfdjr.supabase.co/functions/v1/catalogue-feed'::text),'Live Villiers-date-filtered catalogue endpoint')
on conflict(key) do update
set value=excluded.value,description=excluded.description,updated_at=now();

update public.shops
set catalogue_url='https://uoqgbaqffmxdnenxfdjr.supabase.co/functions/v1/catalogue-feed'
where catalogue_url is distinct from 'https://uoqgbaqffmxdnenxfdjr.supabase.co/functions/v1/catalogue-feed';
