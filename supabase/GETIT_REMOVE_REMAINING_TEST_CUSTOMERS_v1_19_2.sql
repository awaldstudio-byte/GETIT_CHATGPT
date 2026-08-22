-- Follow-up to v1.19.1: use an ASCII-only suffix match so the cleanup is
-- independent of shell/editor encoding for the separator before TEST.
delete from public.customers customer
where customer.full_name ~ 'TEST$'
  and not exists (select 1 from public.orders o where o.customer_id = customer.id)
  and not exists (select 1 from public.messaging_conversations c where c.customer_id = customer.id);
