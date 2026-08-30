const LIVE_TABLES = [
  'orders',
  'order_items',
  'drivers',
  'driver_sessions',
  'driver_zones',
  'delivery_zones',
  'delivery_runs',
  'delivery_run_pickups',
  'payment_reviews',
  'support_queries',
  'automation_events',
  'customers',
  'shops',
  'products',
  'messaging_conversations',
  'messaging_messages',
  'messaging_attachments',
  'messaging_handoff_events',
  'messaging_incidents',
  'messaging_order_drafts',
  'messaging_conversation_participants',
  'partner_applications',
  'partner_application_files',
  'partner_catalogue_submissions',
];

const throwIfError = ({ data, error }) => {
  if (error) throw error;
  return data;
};

export function createControlCentre({
  supabase,
  refresh,
  onPaymentWaiting = () => {},
  onRealtimeEvent = () => {},
  onConnectionState = () => {},
  onMutationState = () => {},
  onError = console.error,
}) {
  let channel = null;
  let debounceTimer = null;
  let safetyTimer = null;
  let stopped = false;
  let refreshInFlight = null;
  let refreshQueued = false;
  const notifiedPaymentIds = new Set();

  const refreshNow = async (reason) => {
    if (stopped) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return refreshInFlight;
    }

    refreshInFlight = Promise.resolve(refresh({ reason }))
      .catch((error) => {
        onError(error);
        throw error;
      })
      .finally(async () => {
        refreshInFlight = null;
        if (refreshQueued && !stopped) {
          refreshQueued = false;
          await refreshNow('queued-change');
        }
      });

    return refreshInFlight;
  };

  const scheduleRefresh = (reason = 'realtime') => {
    if (stopped) return;
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      refreshNow(reason).catch(() => {});
    }, 120);
  };

  const mutate = async (label, rpcName, args = {}) => {
    onMutationState({ label, state: 'saving' });
    try {
      const result = await supabase.rpc(rpcName, args);
      const data = throwIfError(result);
      await refreshNow(`mutation:${rpcName}`);
      onMutationState({ label, state: 'saved' });
      return data;
    } catch (error) {
      onMutationState({ label, state: 'error', error });
      onError(error);
      await refreshNow(`rollback:${rpcName}`).catch(() => {});
      throw error;
    }
  };

  const start = () => {
    if (channel) return;
    stopped = false;
    const channelId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    channel = supabase.channel(`getit-control-centre-${channelId}`);

    for (const table of LIVE_TABLES) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload) => {
          onRealtimeEvent({ table, eventType: payload.eventType, payload });
          if (table === 'payment_reviews' && payload.new?.status === 'pending_review') {
            const id = payload.new?.id || payload.new?.order_id;
            const becamePending = payload.eventType === 'INSERT' || payload.old?.status !== 'pending_review';
            if (becamePending && id && !notifiedPaymentIds.has(id)) {
              notifiedPaymentIds.add(id);
              onPaymentWaiting(payload.new);
            }
          }
          if (table === 'payment_reviews' && payload.new?.status !== 'pending_review') {
            const id = payload.new?.id || payload.new?.order_id;
            if (id) notifiedPaymentIds.delete(id);
          }
          scheduleRefresh(`${table}:${payload.eventType}`);
        },
      );
    }

    channel.subscribe((status, error) => {
      onConnectionState({ status, error });
      if (error) onError(error);
      if (status === 'SUBSCRIBED') scheduleRefresh('realtime-connected');
    });

    safetyTimer = window.setInterval(
      () => scheduleRefresh('five-minute-safety-refresh'),
      5 * 60 * 1000,
    );
  };

  const stop = async () => {
    stopped = true;
    window.clearTimeout(debounceTimer);
    window.clearInterval(safetyTimer);
    if (channel) await supabase.removeChannel(channel);
    channel = null;
  };

  const queries = {
    async dashboard() {
      const [
        drivers,
        orders,
        paymentQueue,
        orderPins,
        shopPins,
        openQueries,
        health,
        messagingInbox,
        messagingDirectory,
        messagingHealth,
        partnerApplications,
        partnerCatalogueSubmissions,
        partnerApplicationFiles,
        automationEvents,
      ] =
        await Promise.all([
          supabase.from('driver_control_board').select('*').order('driver_name'),
          supabase
            .from('control_centre_orders')
            .select('*')
            .order('priority', { ascending: false })
            .order('created_at', { ascending: true }),
          supabase
            .from('payment_review_queue')
            .select('*')
            .in('status', ['pending_review', 'approved', 'link_requested', 'link_ready'])
            .order('requested_at', { ascending: true }),
          supabase.from('map_order_pins_v2').select('*'),
          supabase.from('map_shop_pins_v2').select('*'),
          supabase
            .from('support_queries')
            .select('id,order_id,issue_type,issue_summary,created_at')
            .eq('status', 'open')
            .order('created_at', { ascending: true }),
          supabase.rpc('get_getit_operator_health'),
          supabase.rpc('get_messaging_dock_inbox', { p_limit: 300 }),
          supabase.rpc('get_messaging_chat_directory'),
          supabase.rpc('get_messaging_operator_health'),
          supabase.rpc('get_partner_application_queue', { p_limit: 200 }),
          supabase.rpc('get_partner_catalogue_submission_queue', { p_limit: 300 }),
          supabase
            .from('partner_application_files')
            .select('*,attachment:messaging_attachments(id,conversation_id,message_id,attachment_type,mime_type,file_name,caption,is_voice,retrieval_status,retrieval_error_code,transcription_status,transcription_text,transcription_error,file_size_bytes,storage_bucket,storage_path,archived_at,created_at)')
            .order('created_at', { ascending: true })
            .limit(500),
          supabase
            .from('automation_events')
            .select('id,event_type,order_id,status,attempts,error_message,created_at,updated_at,orders(order_number)')
            .in('status', ['pending', 'processing', 'failed'])
            .order('created_at', { ascending: true })
            .limit(200),
        ]);

      const activePayments = throwIfError(paymentQueue) || [];
      const paymentRank = {
        pending_review: 0,
        approved: 1,
        link_requested: 2,
        link_ready: 3,
      };
      activePayments.sort((a, b) => {
        if (Boolean(a.human_help_required) !== Boolean(b.human_help_required)) {
          return a.human_help_required ? 1 : -1;
        }
        if (Boolean(a.priority) !== Boolean(b.priority)) return a.priority ? -1 : 1;
        const rankDifference = (paymentRank[a.status] ?? 9) - (paymentRank[b.status] ?? 9);
        return rankDifference || new Date(a.requested_at) - new Date(b.requested_at);
      });

      const dashboardOrders = throwIfError(orders) || [];
      const orderLookup = new Map(dashboardOrders.map((order) => [order.id, order]));
      const enrichedQueries = (throwIfError(openQueries) || [])
        .map((query) => ({
          ...query,
          ...(orderLookup.get(query.order_id) || {}),
          id: query.id,
          order_id: query.order_id,
          issue_type: query.issue_type,
          issue_summary: query.issue_summary,
          created_at: query.created_at,
        }))
        .sort((a, b) => {
          if (Boolean(a.priority) !== Boolean(b.priority)) return a.priority ? -1 : 1;
          return new Date(a.created_at) - new Date(b.created_at);
        });

      return {
        drivers: throwIfError(drivers) || [],
        orders: dashboardOrders,
        paymentQueue: activePayments,
        orderPins: throwIfError(orderPins) || [],
        shopPins: throwIfError(shopPins) || [],
        openQueries: enrichedQueries,
        health: throwIfError(health) || null,
        messagingInbox: throwIfError(messagingInbox) || [],
        messagingDirectory: throwIfError(messagingDirectory) || [],
        messagingHealth: throwIfError(messagingHealth) || null,
        partnerApplications: throwIfError(partnerApplications) || [],
        partnerCatalogueSubmissions: throwIfError(partnerCatalogueSubmissions) || [],
        partnerApplicationFiles: throwIfError(partnerApplicationFiles) || [],
        automationEvents: throwIfError(automationEvents) || [],
      };
    },

    async messagingConversation(conversationId, customerId = null) {
      const recentOrdersQuery = customerId
        ? supabase
            .from('control_centre_orders')
            .select('*')
            .eq('customer_id', customerId)
            .order('created_at', { ascending: false })
            .limit(5)
        : Promise.resolve({ data: [], error: null });

      const [messages, attachments, decisions, handoffs, incidents, draft, recentOrders] =
        await Promise.all([
          supabase
            .from('messaging_messages')
            .select('*')
            .eq('conversation_id', conversationId)
            .order('id', { ascending: true })
            .limit(300),
          supabase
            .from('messaging_attachments')
            .select('id,conversation_id,message_id,attachment_type,mime_type,file_name,caption,is_voice,retrieval_status,retrieval_error_code,transcription_status,transcription_text,transcription_error,file_size_bytes,storage_bucket,storage_path,archived_at,created_at')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: true })
            .limit(500),
          supabase.rpc('get_messaging_decisions_for_conversation', {
            p_conversation_id: conversationId,
            p_limit: 100,
          }),
          supabase
            .from('messaging_handoff_events')
            .select('*')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: false })
            .limit(100),
          supabase
            .from('messaging_incidents')
            .select('*')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: false })
            .limit(100),
          supabase
            .from('messaging_order_drafts')
            .select('*')
            .eq('conversation_id', conversationId)
            .maybeSingle(),
          recentOrdersQuery,
        ]);

      return {
        messages: throwIfError(messages) || [],
        attachments: throwIfError(attachments) || [],
        decisions: throwIfError(decisions) || [],
        handoffs: throwIfError(handoffs) || [],
        incidents: throwIfError(incidents) || [],
        draft: throwIfError(draft),
        recentOrders: throwIfError(recentOrders) || [],
      };
    },

    async orderReview(orderId) {
      const [lines, review, order] = await Promise.all([
        supabase
          .from('order_review_lines')
          .select('*')
          .eq('order_id', orderId)
          .order('shop_name')
          .order('item_name'),
        supabase.from('payment_reviews').select('*').eq('order_id', orderId).maybeSingle(),
        supabase.from('control_centre_orders').select('*').eq('id', orderId).single(),
      ]);
      return {
        lines: throwIfError(lines) || [],
        review: throwIfError(review),
        order: throwIfError(order),
      };
    },

    async manualDriverOptions(orderId) {
      return (
        throwIfError(
          await supabase.rpc('manual_driver_options', { p_order_id: orderId }),
        ) || []
      );
    },
  };

  const actions = {
    autoPack: () => mutate('Auto pack', 'auto_pack_waiting_orders'),
    setDriverOverride: (driverId, status, reason = null, until = null) =>
      mutate('Driver availability', 'override_driver_availability', {
        p_driver_id: driverId,
        p_status: status,
        p_reason: reason,
        p_until: until,
      }),
    clearDriverOverride: (driverId) =>
      mutate('Driver availability', 'clear_driver_override', { p_driver_id: driverId }),
    assignDriver: (orderId, driverId, force = false) =>
      mutate('Driver assignment', 'assign_order_to_driver', {
        p_order_id: orderId,
        p_driver_id: driverId,
        p_force: force,
      }),
    advanceRunFulfilment: (runId, nextStatus) =>
      mutate('Run fulfilment', 'advance_delivery_run_fulfilment', {
        p_run_id: runId,
        p_next_status: nextStatus,
      }),
    departRun: (runId) =>
      mutate('Driver departure', 'depart_delivery_run', { p_run_id: runId }),
    completeRun: (runId) =>
      mutate('Complete run', 'complete_delivery_run', { p_run_id: runId }),
    updateItemPrice: (orderItemId, unitPrice, note = null) =>
      mutate('Item price', 'update_order_item_review_price', {
        p_order_item_id: orderItemId,
        p_unit_price: unitPrice,
        p_note: note,
      }),
    approvePayment: (orderId, note = null) =>
      mutate('Payment approval', 'approve_payment_review', {
        p_order_id: orderId,
        p_review_note: note,
      }),
    approvePaymentWithPrices: (orderId, items, note = null) =>
      mutate('Payment approval', 'approve_payment_review_with_prices', {
        p_order_id: orderId,
        p_items: items,
        p_review_note: note,
      }),
    saveOrderLocation: ({
      orderId,
      latitude,
      longitude,
      source = 'control_centre',
      accuracyMeters = null,
      typedAddress = null,
      confirmed = false,
      note = null,
    }) =>
      mutate('Delivery pin', 'save_order_location', {
        p_order_id: orderId,
        p_latitude: latitude,
        p_longitude: longitude,
        p_source: source,
        p_accuracy_meters: accuracyMeters,
        p_typed_address: typedAddress,
        p_confirmed: confirmed,
        p_note: note,
      }),
    confirmOrderLocation: (orderId, confirmed = true, note = null) =>
      mutate('Location confirmation', 'confirm_order_location', {
        p_order_id: orderId,
        p_confirmed: confirmed,
        p_note: note,
      }),
    saveShopLocation: ({ shopId, latitude, longitude, streetAddress = null, verified = true, note = null }) =>
      mutate('Shop pin', 'save_shop_location_v18', {
        p_shop_id: shopId,
        p_latitude: latitude,
        p_longitude: longitude,
        p_street_address: streetAddress,
        p_verified: verified,
        p_note: note,
      }),
    createSupportQuery: (orderId, issueType, summary) =>
      mutate('Needs help', 'create_support_query_v19', {
        p_order_id: orderId,
        p_issue_type: issueType,
        p_issue_summary: summary,
      }),
    resolveSupportQuery: (queryId, resolutionNote) =>
      mutate('Help request', 'resolve_support_query', {
        p_query_id: queryId,
        p_resolution_note: resolutionNote,
      }),
    setMessagingMode: (conversationId, nextMode, reason, expectedVersion) =>
      mutate('Conversation mode', 'set_messaging_conversation_mode_v2', {
        p_conversation_id: conversationId,
        p_new_mode: nextMode,
        p_reason: reason,
        p_expected_version: expectedVersion,
      }),
    sendStaffMessage: (conversationId, body, idempotencyKey, inReplyToMessageId = null) =>
      mutate('Staff reply', 'queue_staff_outbound_message', {
        p_conversation_id: conversationId,
        p_idempotency_key: idempotencyKey,
        p_body: body,
        p_in_reply_to_message_id: inReplyToMessageId,
      }),
    markMessagingRead: (conversationId, lastMessageId = null) =>
      mutate('Read messages', 'mark_messaging_conversation_read', {
        p_conversation_id: conversationId,
        p_last_message_id: lastMessageId,
      }),
    resetMessagingConversation: (conversationId, expectedVersion, reason) =>
      mutate('Clear chat', 'reset_messaging_conversation_v1', {
        p_conversation_id: conversationId,
        p_expected_version: expectedVersion,
        p_reason: reason,
      }),
    sendMessagingPresence: async (providerMessageId, typing = false) => {
      if (!providerMessageId) return null;
      const { data, error } = await supabase.functions.invoke('meta-whatsapp-presence', {
        body: { message_id: providerMessageId, typing_indicator: Boolean(typing) },
      });
      if (error) throw error;
      return data;
    },
    resolveMessagingIncident: (incidentId, status, resolutionNote, expectedUpdatedAt) =>
      mutate('Messaging incident', 'resolve_messaging_incident_v2', {
        p_incident_id: incidentId,
        p_status: status,
        p_resolution_note: resolutionNote,
        p_expected_updated_at: expectedUpdatedAt,
      }),
    openMessagingParticipant: (participantType, participantId, phone = null) =>
      mutate('Open chat', 'open_messaging_participant_conversation', {
        p_participant_type: participantType,
        p_participant_id: participantId,
        p_phone: phone,
      }),
    reviewPartnerApplication: (applicationId, status, reviewNote, expectedVersion) =>
      mutate('Partner application', 'review_partner_application_v2', {
        p_application_id: applicationId,
        p_new_status: status,
        p_review_note: reviewNote || null,
        p_expected_version: expectedVersion,
      }),
  };

  return { start, stop, refreshNow, scheduleRefresh, queries, actions };
}
