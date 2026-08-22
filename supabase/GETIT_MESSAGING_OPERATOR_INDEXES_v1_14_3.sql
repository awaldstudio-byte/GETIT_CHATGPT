begin;

create index if not exists messaging_operator_reads_staff_idx
  on public.messaging_operator_reads(staff_user_id);

create index if not exists messaging_operator_reads_last_message_idx
  on public.messaging_operator_reads(last_read_message_id)
  where last_read_message_id is not null;

create index if not exists messaging_order_drafts_source_message_idx
  on public.messaging_order_drafts(source_message_id)
  where source_message_id is not null;

create index if not exists messaging_order_drafts_confirmed_message_idx
  on public.messaging_order_drafts(confirmed_by_message_id)
  where confirmed_by_message_id is not null;

commit;
