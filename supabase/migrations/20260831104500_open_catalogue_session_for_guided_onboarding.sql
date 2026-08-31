-- When guided onboarding reaches the optional catalogue-material step, allow
-- the approved shop to send its existing file directly without a magic phrase.

create or replace function private.open_partner_catalogue_session_for_guided_onboarding()
returns trigger
language plpgsql security definer set search_path=''
as $$
begin
  if new.requirement_key='catalogue_material'
     and new.status='requested'
     and old.status is distinct from new.status then
    update public.partner_applications a
    set answers=jsonb_set(
          a.answers,
          '{catalogue_upload_session}',
          jsonb_build_object(
            'opened_at',now(),
            'expires_at',now()+interval '7 days',
            'source','guided_onboarding',
            'requirement_id',new.id
          ),
          true
        )
    where a.id=new.application_id
      and a.status='approved';
  end if;
  return new;
end;
$$;

drop trigger if exists partner_onboarding_open_catalogue_session on public.partner_onboarding_requirements;
create trigger partner_onboarding_open_catalogue_session
after update of status on public.partner_onboarding_requirements
for each row execute function private.open_partner_catalogue_session_for_guided_onboarding();

comment on function private.open_partner_catalogue_session_for_guided_onboarding() is
  'Opens a bounded private catalogue-upload window when an approved shop reaches that guided-onboarding step.';
