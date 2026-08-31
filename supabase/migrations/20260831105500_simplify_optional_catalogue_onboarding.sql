-- A shop that chooses shop-on-request should not be asked for catalogue files.

create or replace function private.open_partner_catalogue_session_for_guided_onboarding()
returns trigger
language plpgsql security definer set search_path=''
as $$
begin
  if new.requirement_key='catalogue_preference'
     and new.status='received_pending_review'
     and old.status is distinct from new.status
     and coalesce(new.current_value,'') ~* '(no catalogue|without (a )?catalogue|shop[- ]on[- ]request|contact (us|the shop)|ask (us|the shop)|when (a )?customer asks)' then
    update public.partner_onboarding_requirements r
    set status='not_applicable',
        staff_note='Shop chose the optional shop-on-request route; no catalogue material required.',
        completed_at=now(),version=r.version+1
    where r.application_id=new.application_id
      and r.requirement_key='catalogue_material'
      and r.status in ('not_started','requested','needs_guidance','partial','blocked');
  end if;

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
    where a.id=new.application_id and a.status='approved';
  end if;
  return new;
end;
$$;

comment on function private.open_partner_catalogue_session_for_guided_onboarding() is
  'Keeps catalogue onboarding optional and opens a bounded private upload window only when catalogue material is requested.';
