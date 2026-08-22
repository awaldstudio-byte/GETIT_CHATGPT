-- Cover partner application foreign keys used by review and cleanup paths.
create index if not exists partner_applications_source_message_idx
  on public.partner_applications(source_message_id)
  where source_message_id is not null;
create index if not exists partner_applications_assigned_staff_idx
  on public.partner_applications(assigned_staff_user_id)
  where assigned_staff_user_id is not null;
create index if not exists partner_applications_reviewed_by_idx
  on public.partner_applications(reviewed_by)
  where reviewed_by is not null;
create index if not exists partner_application_receipts_application_idx
  on private.partner_application_message_receipts(application_id)
  where application_id is not null;
