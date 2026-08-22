begin;

insert into public.app_settings(key, value, description, updated_at)
values
  ('messaging_human_inbox', '"getit_control_centre"'::jsonb, 'Authoritative human messaging inbox. Chatwoot is removed.', now()),
  ('messaging_chatwoot_enabled', 'false'::jsonb, 'Compatibility artifacts may remain, but no current workflow may use Chatwoot.', now())
on conflict (key) do update
set value = excluded.value,
    description = excluded.description,
    updated_at = now();

comment on table public.messaging_chatwoot_links is
  'Legacy compatibility only. Chatwoot is removed; no current Getit workflow may depend on this table.';

comment on table private.messaging_chatwoot_mirror_outbox is
  'Legacy compatibility only. Chatwoot is removed; no current Getit workflow may claim or deliver these rows.';

commit;
