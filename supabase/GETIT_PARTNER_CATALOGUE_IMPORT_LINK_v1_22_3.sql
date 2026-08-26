-- Link reviewed WhatsApp catalogue submissions to the existing staff import pipeline.

alter table public.partner_catalogue_submissions
  drop constraint if exists partner_catalogue_submissions_status_check;

alter table public.partner_catalogue_submissions
  add constraint partner_catalogue_submissions_status_check check (status in (
    'awaiting_upload','awaiting_kind','awaiting_validity','awaiting_refresh',
    'ready_for_review','imported','upload_failed','rejected','withdrawn'
  ));

comment on column public.partner_catalogue_submissions.status is
  'Review-only intake state. imported means staff linked the private submission to a catalogue source and staging batch.';
