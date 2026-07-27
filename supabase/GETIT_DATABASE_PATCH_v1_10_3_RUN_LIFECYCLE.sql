-- GETIT Control Centre v1.10.3
-- Adds authenticated, run-level fulfilment transitions.
-- Load finalisation is intentionally deferred to the next repository update.

create or replace function public.advance_delivery_run_fulfilment(
  p_run_id uuid,
  p_next_status text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_status text;
  v_changed integer;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to update delivery runs';
  end if;

  if p_next_status not in ('shopping', 'packing', 'ready') then
    raise exception 'Unsupported fulfilment status';
  end if;

  select status
  into v_run_status
  from public.delivery_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'Delivery run not found';
  end if;

  if v_run_status not in ('open', 'full') then
    raise exception 'This run has already departed or closed';
  end if;

  if not exists (
    select 1
    from public.orders
    where delivery_run_id = p_run_id
      and status <> 'cancelled'
  ) then
    raise exception 'This run has no active orders';
  end if;

  if p_next_status = 'shopping' then
    if exists (
      select 1 from public.orders
      where delivery_run_id = p_run_id
        and status not in ('paid', 'shopping', 'cancelled')
    ) then
      raise exception 'Shopping cannot start from the current order state';
    end if;

    update public.orders
    set status = 'shopping'
    where delivery_run_id = p_run_id
      and status = 'paid';

    update public.delivery_run_pickups
    set status = 'collecting'
    where delivery_run_id = p_run_id
      and status = 'pending';
  elsif p_next_status = 'packing' then
    if exists (
      select 1 from public.orders
      where delivery_run_id = p_run_id
        and status not in ('shopping', 'packing', 'cancelled')
    ) then
      raise exception 'Every active order must be shopping before packing starts';
    end if;

    update public.orders
    set status = 'packing'
    where delivery_run_id = p_run_id
      and status = 'shopping';

    update public.delivery_run_pickups
    set status = 'collected'
    where delivery_run_id = p_run_id
      and status in ('pending', 'collecting');
  else
    if exists (
      select 1 from public.orders
      where delivery_run_id = p_run_id
        and status not in ('packing', 'ready', 'cancelled')
    ) then
      raise exception 'Every active order must be packing before collection is completed';
    end if;

    update public.orders
    set status = 'ready'
    where delivery_run_id = p_run_id
      and status = 'packing';
  end if;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

revoke execute on function public.advance_delivery_run_fulfilment(uuid, text)
from public, anon;
grant execute on function public.advance_delivery_run_fulfilment(uuid, text)
to authenticated;

create or replace function public.depart_delivery_run(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver_id uuid;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to dispatch drivers';
  end if;

  if exists (
    select 1 from public.orders
    where delivery_run_id = p_run_id
      and status not in ('ready', 'cancelled')
  ) then
    raise exception 'Every active order must be collected and ready before departure';
  end if;

  update public.delivery_runs
  set
    status = 'active',
    departed_at = now(),
    closed_reason = coalesce(closed_reason, 'departed_early')
  where id = p_run_id
    and status in ('open', 'full')
  returning driver_id into v_driver_id;

  if not found then
    raise exception 'Run is not ready to depart';
  end if;

  update public.orders
  set status = 'out_for_delivery'
  where delivery_run_id = p_run_id
    and status = 'ready';

  insert into public.driver_sessions (
    driver_id, logged_in, self_status, system_status, last_seen_at
  )
  values (v_driver_id, true, 'available', 'out_for_delivery', now())
  on conflict (driver_id) do update
  set system_status = 'out_for_delivery', last_seen_at = now();
end;
$$;

revoke execute on function public.depart_delivery_run(uuid)
from public, anon;
grant execute on function public.depart_delivery_run(uuid)
to authenticated;

create or replace function public.complete_delivery_run(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver_id uuid;
begin
  if (select public.current_staff_role()) not in ('owner', 'admin', 'dispatcher') then
    raise exception 'Not authorised to complete driver runs';
  end if;

  update public.delivery_runs
  set status = 'completed', completed_at = now()
  where id = p_run_id
    and status = 'active'
  returning driver_id into v_driver_id;

  if not found then
    raise exception 'Only an active run can be completed';
  end if;

  update public.orders
  set status = 'delivered'
  where delivery_run_id = p_run_id
    and status = 'out_for_delivery';

  update public.driver_sessions
  set system_status = null, last_seen_at = now()
  where driver_id = v_driver_id;

  perform public.auto_pack_waiting_orders();
end;
$$;

revoke execute on function public.complete_delivery_run(uuid)
from public, anon;
grant execute on function public.complete_delivery_run(uuid)
to authenticated;
