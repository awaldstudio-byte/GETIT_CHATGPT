create index if not exists partner_extraction_jobs_requested_by_idx
  on public.partner_application_extraction_jobs(requested_by)
  where requested_by is not null;

create index if not exists partner_field_values_reviewed_by_idx
  on public.partner_application_field_values(reviewed_by)
  where reviewed_by is not null;

create index if not exists partner_field_values_source_file_idx
  on public.partner_application_field_values(source_file_id)
  where source_file_id is not null;

create index if not exists partner_onboarding_requirements_updated_by_idx
  on public.partner_onboarding_requirements(updated_by)
  where updated_by is not null;
