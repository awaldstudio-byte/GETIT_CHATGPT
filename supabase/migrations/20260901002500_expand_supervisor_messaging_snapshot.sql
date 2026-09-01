-- Include the real messaging attention workload in the sanitized supervisor snapshot.
create or replace function public.get_supervisor_operations_snapshot_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_health jsonb;
begin
  perform private.assert_messaging_service_role();
  select jsonb_build_object(
    'status',case
      when count(*) filter (where status in ('pending','failed')) > 0
        or count(*) filter (where status = 'processing' and updated_at < now() - interval '15 minutes') > 0
      then 'attention'
      else 'ok'
    end,
    'automation_backlog',count(*) filter (where status in ('pending','failed','processing')),
    'stuck_processing',count(*) filter (where status = 'processing' and updated_at < now() - interval '15 minutes'),
    'generated_at',now()
  )
  into v_health
  from public.automation_events;

  return jsonb_build_object(
    'captured_at',now(),
    'cash_only',true,
    'prelaunch',jsonb_build_object(
      'public_launch_area',jsonb_build_array('Villiers','Qalabotjha'),
      'normal_order_area','Villiers',
      'launch_date','2026-10-01'
    ),
    'health',coalesce(v_health,'{}'::jsonb),
    'counts',jsonb_build_object(
      'orders_by_status',(
        select coalesce(jsonb_object_agg(s.status,s.total),'{}'::jsonb)
        from (select status,count(*)::integer total from public.orders group by status) s
      ),
      'payments_by_status',(
        select coalesce(jsonb_object_agg(s.status,s.total),'{}'::jsonb)
        from (select status,count(*)::integer total from public.payment_reviews group by status) s
      ),
      'open_support_queries',(select count(*)::integer from public.support_queries where status='open'),
      'open_messaging_incidents',(select count(*)::integer from public.messaging_incidents where status in ('open','investigating')),
      'staff_owned_conversations',(select count(*)::integer from public.messaging_conversations where status<>'closed' and (mode in ('human','paused') or status='waiting_for_staff')),
      'messaging_attention',(
        (select count(*) from public.messaging_conversations where status<>'closed' and (mode='human' or status='waiting_for_staff'))
        + (select count(*) from public.messaging_messages where status='manual_review')
        + (select count(*) from public.messaging_incidents where status in ('open','investigating'))
        + (select count(*) from private.messaging_inbox_events where status in ('quarantined','dead_letter'))
        + (select count(*) from private.messaging_outbox where status in ('failed','dead_letter'))
      )::integer,
      'messaging_manual_review',(select count(*)::integer from public.messaging_messages where status='manual_review'),
      'messaging_inbound_queued',(select count(*)::integer from private.messaging_inbox_events where status in ('pending','processing')),
      'messaging_outbound_queued',(select count(*)::integer from private.messaging_outbox where status in ('pending','processing','failed')),
      'applications_waiting',(select count(*)::integer from public.partner_applications where status in ('submitted','reviewing')),
      'active_waitlist',(select count(*)::integer from public.customer_waitlist where entry_status='active'),
      'active_shops',(select count(*)::integer from public.shops where active),
      'active_drivers',(select count(*)::integer from public.drivers where active),
      'catalogues_waiting_review',(select count(*)::integer from public.partner_catalogue_submissions where status in ('uploaded','extracting','extracted','reviewing')),
      'automation_backlog',(select count(*)::integer from public.automation_events where status in ('pending','failed','processing'))
    ),
    'attention',jsonb_build_object(
      'support_queries',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'id',q.id,'order_id',q.order_id,'issue_type',q.issue_type,
          'summary',left(q.issue_summary,500),'created_at',q.created_at
        ) order by q.created_at),'[]'::jsonb)
        from (select * from public.support_queries where status='open' order by created_at limit 20) q
      ),
      'messaging_incidents',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'id',i.id,'conversation_id',i.conversation_id,'severity',i.severity,
          'category',i.category,'summary',left(i.summary,500),'status',i.status,'created_at',i.created_at
        ) order by i.created_at),'[]'::jsonb)
        from (select * from public.messaging_incidents where status in ('open','investigating') order by created_at limit 20) i
      ),
      'applications',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'id',a.id,'type',a.application_type,'display_name',coalesce(a.business_name,a.applicant_name,'Applicant'),
          'status',a.status,'submitted_at',a.submitted_at,'current_step',a.current_step
        ) order by a.submitted_at nulls last),'[]'::jsonb)
        from (select * from public.partner_applications where status in ('submitted','reviewing') order by submitted_at nulls last limit 20) a
      ),
      'automation_events',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'id',e.id,'event_type',e.event_type,'status',e.status,'attempts',e.attempts,
          'error',left(e.error_message,500),'created_at',e.created_at,'updated_at',e.updated_at
        ) order by e.created_at),'[]'::jsonb)
        from (select * from public.automation_events where status in ('pending','failed','processing') order by created_at limit 20) e
      )
    ),
    'capabilities',jsonb_build_object(
      'mode','read_only_advisor',
      'can_send_customer_messages',false,
      'can_approve_payments',false,
      'can_activate_partners',false,
      'can_execute_database_commands',false,
      'requires_staff_confirmation_for_actions',true
    )
  );
end;
$$;





