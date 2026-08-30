"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dateTime, label, money } from "../../lib/format";
import MediaAttachment from "./MediaAttachment";
import MessageDeliveryStatus from "./MessageDeliveryStatus";

const modeCopy = {
  automation: "Automation",
  human: "Staff takeover",
  paused: "Paused",
  dry_run: "Dry run",
};

const messagePreview = (conversation) => {
  if (conversation.last_message_body) return conversation.last_message_body;
  if (conversation.last_message_type) return `[${label(conversation.last_message_type)}]`;
  return "No messages yet";
};

const attentionTotal = (conversation) =>
  Number(conversation.unread_count || 0) +
  Number(conversation.open_incident_count || 0) +
  Number(conversation.manual_review_count || 0);

function HealthStrip({ health }) {
  if (!health) return null;
  const healthy = health.status === "healthy";
  return (
    <section className={`messaging-health ${healthy ? "healthy" : "attention"}`}>
      <div>
        <span className="eyebrow">Messaging pipeline</span>
        <strong>{healthy ? "Healthy" : `${health.attention_count || 0} need attention`}</strong>
      </div>
      <div className="messaging-health-metrics">
        <span><b>{health.inbox_pending || 0}</b> inbound queued</span>
        <span><b>{health.outbox_pending || 0}</b> outbound queued</span>
        <span><b>{health.human_waiting || 0}</b> waiting for staff</span>
        <span><b>{health.open_incidents || 0}</b> incidents</span>
      </div>
    </section>
  );
}

export default function MessagingInbox({ data, api, onError, onToast, realtimeRevision = 0 }) {
  const conversations = data.messagingInbox || [];
  const [selectedId, setSelectedId] = useState(null);
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState("");
  const [filter, setFilter] = useState("attention");
  const [menuOpen, setMenuOpen] = useState(false);
  const markedReadRef = useRef(new Map());
  const providerReadRef = useRef(new Map());
  const typingSentAtRef = useRef(0);

  const selected = useMemo(
    () => conversations.find((item) => item.conversation_id === selectedId) || null,
    [conversations, selectedId],
  );
  const attachmentsByMessage = useMemo(() => {
    const grouped = new Map();
    for (const attachment of details?.attachments || []) {
      if (!grouped.has(attachment.message_id)) grouped.set(attachment.message_id, []);
      grouped.get(attachment.message_id).push(attachment);
    }
    return grouped;
  }, [details?.attachments]);

  const filteredConversations = useMemo(() => {
    if (filter === "all") return conversations;
    if (filter === "human") {
      return conversations.filter((item) => item.mode === "human" || item.status === "waiting_for_staff");
    }
    return conversations.filter((item) => item.needs_attention);
  }, [conversations, filter]);

  useEffect(() => {
    if (!selectedId && conversations[0]) setSelectedId(conversations[0].conversation_id);
    if (selectedId && conversations.length && !selected) {
      setSelectedId(conversations[0]?.conversation_id || null);
    }
  }, [conversations, selected, selectedId]);

  useEffect(() => setMenuOpen(false), [selectedId]);

  const loadConversation = useCallback(async () => {
    if (!selected || !api) {
      setDetails(null);
      return;
    }
    setLoading(true);
    try {
      const next = await api.queries.messagingConversation(
        selected.conversation_id,
        selected.customer_id,
      );
      setDetails(next);

      const lastMessageId = next.messages.at(-1)?.id || null;
      const markedMessageId = markedReadRef.current.get(selected.conversation_id);
      if (lastMessageId && markedMessageId !== lastMessageId && Number(selected.unread_count || 0) > 0) {
        markedReadRef.current.set(selected.conversation_id, lastMessageId);
        await api.actions.markMessagingRead(selected.conversation_id, lastMessageId);
      }
      const lastInbound = [...next.messages].reverse().find((message) => message.direction === "inbound" && message.provider_message_id);
      if (lastInbound?.provider_message_id && providerReadRef.current.get(selected.conversation_id) !== lastInbound.provider_message_id) {
        providerReadRef.current.set(selected.conversation_id, lastInbound.provider_message_id);
        api.actions.sendMessagingPresence(lastInbound.provider_message_id, false).catch(() => {});
      }
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [api, onError, selected]);

  useEffect(() => {
    loadConversation();
  }, [loadConversation, selected?.last_message_id, selected?.version, realtimeRevision]);

  useEffect(() => {
    if (!selectedId) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadConversation();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [loadConversation, selectedId]);

  const changeMode = async (nextMode) => {
    if (!selected || busy) return;
    if (nextMode === "automation" && !window.confirm(
      "Enable live automation for this conversation? Only do this after dry-run validation is clean.",
    )) return;

    const reason = {
      human: "Staff takeover from Getit Control Centre",
      dry_run: "Released by staff to safe dry-run mode",
      paused: "Paused by staff in Getit Control Centre",
      automation: "Controlled conversation automation enabled by staff",
    }[nextMode];

    setBusy(true);
    try {
      await api.actions.setMessagingMode(
        selected.conversation_id,
        nextMode,
        reason,
        selected.version,
      );
      onToast(`${modeCopy[nextMode]} enabled`);
      await loadConversation();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const copyCustomerNumber = async () => {
    const phone = selected?.customer_phone;
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      onToast("WhatsApp number copied");
      setMenuOpen(false);
    } catch (error) {
      onError(error);
    }
  };

  const clearConversation = async () => {
    if (!selected || busy) return;
    const confirmed = window.confirm(
      `Reset Getit's conversation with ${selected.customer_name}?\n\nThis removes the Control Centre timeline, AI memory, unread state, incidents and any active draft. It keeps the customer's profile and submitted orders. It does not erase the separate chat history shown inside WhatsApp.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setMenuOpen(false);
    try {
      const result = await api.actions.resetMessagingConversation(
        selected.conversation_id,
        selected.version,
        "Fresh start requested from Getit Control Centre",
      );
      markedReadRef.current.delete(selected.conversation_id);
      providerReadRef.current.delete(selected.conversation_id);
      setComposer("");
      setDetails({ messages: [], attachments: [], decisions: [], handoffs: [], incidents: [], draft: null, recentOrders: details?.recentOrders || [] });
      const removedMessages = Number(result?.removed_counts?.messages || 0);
      onToast(`Getit reset complete${removedMessages ? ` — ${removedMessages} message${removedMessages === 1 ? "" : "s"} removed` : ""}. WhatsApp's own history is unchanged.`);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async (event) => {
    event.preventDefault();
    const body = composer.trim();
    if (!selected || !body || busy) return;
    setBusy(true);
    try {
      const key = `control-centre:${selected.conversation_id}:${crypto.randomUUID()}`;
      await api.actions.sendStaffMessage(selected.conversation_id, body, key);
      setComposer("");
      onToast("Reply queued in the canonical outbox");
      await loadConversation();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleComposerChange = (event) => {
    const value = event.target.value;
    setComposer(value);
    if (!value.trim() || selected?.mode !== "human") return;
    const now = Date.now();
    if (now - typingSentAtRef.current < 15000) return;
    const lastInbound = [...(details?.messages || [])].reverse().find((message) => message.direction === "inbound" && message.provider_message_id);
    if (!lastInbound?.provider_message_id) return;
    typingSentAtRef.current = now;
    api.actions.sendMessagingPresence(lastInbound.provider_message_id, true).catch(() => {});
  };

  const updateIncident = async (incident, nextStatus) => {
    const note = window.prompt(
      nextStatus === "investigating" ? "What are you checking?" : "Add a resolution note:",
    );
    if (!note?.trim() || busy) return;
    setBusy(true);
    try {
      await api.actions.resolveMessagingIncident(
        incident.id,
        nextStatus,
        note.trim(),
        incident.updated_at,
      );
      onToast(nextStatus === "investigating" ? "Incident assigned" : "Incident resolved");
      await loadConversation();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="dashboard-shell messaging-page">
      <HealthStrip health={data.messagingHealth} />

      <div className="messaging-toolbar">
        <div>
          <span className="eyebrow">Customer messaging</span>
          <h1>Inbox</h1>
          <p>Supabase is authoritative. Every staff reply passes through the protected outbox.</p>
        </div>
        <div className="messaging-filters" role="group" aria-label="Conversation filter">
          {[
            ["attention", "Needs attention"],
            ["human", "Staff takeover"],
            ["all", "All"],
          ].map(([value, text]) => (
            <button
              type="button"
              key={value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {!conversations.length ? (
        <section className="panel messaging-empty">
          <div className="empty-orbit">G</div>
          <strong>The messaging pipeline is ready</strong>
          <span>No WhatsApp conversations have reached GETIT-CORE yet. New conversations will appear here live.</span>
          <small>Default mode: dry run. No automated customer reply is allowed until deliberately promoted.</small>
        </section>
      ) : (
        <div className="messaging-layout">
          <aside className="panel conversation-list">
            <div className="conversation-list-heading">
              <strong>{filteredConversations.length} conversations</strong>
              <span>{conversations.reduce((sum, item) => sum + Number(item.unread_count || 0), 0)} unread</span>
            </div>
            <div className="conversation-scroll">
              {filteredConversations.map((conversation) => {
                const attention = attentionTotal(conversation);
                return (
                  <button
                    type="button"
                    key={conversation.conversation_id}
                    className={`conversation-card ${selectedId === conversation.conversation_id ? "active" : ""}`}
                    onClick={() => setSelectedId(conversation.conversation_id)}
                  >
                    <div className="conversation-card-top">
                      <strong>{conversation.customer_name}</strong>
                      <time>{dateTime(conversation.last_message_at)}</time>
                    </div>
                    <div className="conversation-preview">
                      <span>{messagePreview(conversation)}</span>
                      {attention > 0 && <b>{attention}</b>}
                    </div>
                    <div className="conversation-tags">
                      <span className={`tag messaging-mode ${conversation.mode}`}>{modeCopy[conversation.mode] || label(conversation.mode)}</span>
                      {conversation.open_incident_count > 0 && <span className="tag incident">Incident</span>}
                      {conversation.draft_stage !== "idle" && <span className="tag draft">Draft: {label(conversation.draft_stage)}</span>}
                    </div>
                  </button>
                );
              })}
              {!filteredConversations.length && (
                <div className="conversation-filter-empty">Nothing in this queue.</div>
              )}
            </div>
          </aside>

          <section className="panel message-thread-panel">
            {selected && (
              <>
                <header className="message-thread-header">
                  <div>
                    <span className="eyebrow">{selected.customer_phone || "WhatsApp customer"}</span>
                    <h2>{selected.customer_name}</h2>
                    <div className="conversation-tags">
                      <span className={`tag messaging-mode ${selected.mode}`}>{modeCopy[selected.mode] || label(selected.mode)}</span>
                      <span className="tag">{label(selected.status)}</span>
                    </div>
                  </div>
                  <div className="message-thread-actions">
                    <div className="mode-controls">
                      {selected.mode !== "human" && (
                        <button type="button" className="primary-button" onClick={() => changeMode("human")} disabled={busy}>Take over</button>
                      )}
                      {selected.mode !== "dry_run" && (
                        <button type="button" className="small-button" onClick={() => changeMode("dry_run")} disabled={busy}>Release to dry run</button>
                      )}
                      {selected.mode !== "paused" && (
                        <button type="button" className="small-button" onClick={() => changeMode("paused")} disabled={busy}>Pause</button>
                      )}
                      {selected.mode !== "automation" && (
                        <button type="button" className="small-button automation-button" onClick={() => changeMode("automation")} disabled={busy}>Enable automation</button>
                      )}
                    </div>
                    <div className="chat-overflow-menu">
                      <button
                        type="button"
                        className="chat-overflow-trigger"
                        aria-label="More chat actions"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOpen((open) => !open)}
                        disabled={busy}
                      >•••</button>
                      {menuOpen && (
                        <div className="chat-overflow-popover" role="menu">
                          {selected.mode !== "human" && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); changeMode("human"); }}>Take over chat</button>}
                          {selected.mode !== "automation" && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); changeMode("automation"); }}>Enable AI</button>}
                          {selected.mode !== "paused" && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); changeMode("paused"); }}>Pause replies</button>}
                          {selected.customer_phone && <button type="button" role="menuitem" onClick={copyCustomerNumber}>Copy WhatsApp number</button>}
                          <button type="button" role="menuitem" className="danger" onClick={clearConversation}>Reset Getit memory & timeline</button>
                        </div>
                      )}
                    </div>
                  </div>
                </header>

                <div className="message-thread" aria-live="polite">
                  {loading && !details ? <div className="thread-loading">Loading conversation...</div> : null}
                  {(details?.messages || []).map((message) => {
                    const attachments = attachmentsByMessage.get(message.id) || [];
                    return (
                    <article key={message.id} className={`message-bubble ${message.direction}`}>
                      <div className="message-meta">
                        <strong>{message.direction === "inbound" ? selected.customer_name : "Getit"}</strong>
                        <time>{dateTime(message.created_at)}</time>
                      </div>
                      {message.body ? <p>{message.body}</p> : attachments.length === 0 ? <p>[{label(message.message_type)} message]</p> : null}
                      {attachments.map((attachment) => (
                        <MediaAttachment key={attachment.id} attachment={attachment} compact />
                      ))}
                      <div className="message-status">
                        {message.direction === "outbound" ? <MessageDeliveryStatus message={message} /> : <span>Received</span>}
                        {message.error_code && <b>{label(message.error_code)}</b>}
                      </div>
                    </article>
                  );})}
                  {details && !details.messages.length && <div className="thread-loading">No messages recorded yet.</div>}
                </div>

                <form className="message-composer" onSubmit={sendReply}>
                  {selected.mode !== "human" && (
                    <div className="composer-lock">Take over this conversation before sending a staff reply.</div>
                  )}
                  <textarea
                    value={composer}
                    onChange={handleComposerChange}
                    placeholder={selected.mode === "human" ? "Write a reply..." : "Staff reply is locked"}
                    maxLength={4096}
                    disabled={selected.mode !== "human" || busy}
                    rows={3}
                  />
                  <div>
                    <span>{composer.length}/4096</span>
                    <button type="submit" className="primary-button" disabled={selected.mode !== "human" || !composer.trim() || busy}>
                      {busy ? "Working..." : "Queue reply"}
                    </button>
                  </div>
                </form>
              </>
            )}
          </section>

          <aside className="conversation-inspector">
            <InspectorSection title="Order draft" count={selected?.draft_version || 0}>
              {details?.draft ? (
                <>
                  <div className="inspector-summary-row"><span>Stage</span><strong>{label(details.draft.state?.stage || "idle")}</strong></div>
                  <div className="inspector-summary-row"><span>Orders</span><strong>{details.draft.state?.orders?.length || 0}</strong></div>
                  <div className="inspector-summary-row"><span>Version</span><strong>{details.draft.version}</strong></div>
                  {details.draft.confirmed_at && <div className="inspector-summary-row"><span>Confirmed</span><strong>{dateTime(details.draft.confirmed_at)}</strong></div>}
                </>
              ) : <span className="inspector-empty">No active draft.</span>}
            </InspectorSection>

            <InspectorSection title="Recent orders" count={details?.recentOrders?.length || 0}>
              {(details?.recentOrders || []).map((order) => (
                <div className="audit-row" key={order.id}>
                  <div><strong>{order.order_number}</strong><span>{dateTime(order.created_at)}</span></div>
                  <div><span>{label(order.status)}</span><b>{money(order.order_total)}</b></div>
                </div>
              ))}
              {details && !details.recentOrders.length && <span className="inspector-empty">No related orders.</span>}
            </InspectorSection>

            <InspectorSection title="Incidents" count={details?.incidents?.filter((item) => ["open", "investigating"].includes(item.status)).length || 0} tone="danger">
              {(details?.incidents || []).map((incident) => (
                <div className={`audit-row incident-row ${incident.status}`} key={incident.id}>
                  <div><strong>{incident.summary}</strong><span>{label(incident.category)} · {dateTime(incident.created_at)}</span></div>
                  <div className="incident-actions">
                    <span className={`tag ${incident.severity}`}>{label(incident.severity)}</span>
                    {["open", "investigating"].includes(incident.status) && (
                      <>
                        {incident.status === "open" && <button type="button" onClick={() => updateIncident(incident, "investigating")} disabled={busy}>Investigate</button>}
                        <button type="button" onClick={() => updateIncident(incident, "resolved")} disabled={busy}>Resolve</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {details && !details.incidents.length && <span className="inspector-empty">No incidents.</span>}
            </InspectorSection>

            <InspectorSection title="Decision audit" count={details?.decisions?.length || 0}>
              {(details?.decisions || []).map((decision) => (
                <div className="audit-row" key={decision.decision_id}>
                  <div><strong>{label(decision.decision)}</strong><span>{label(decision.reason_code)}</span></div>
                  <div><span>{dateTime(decision.created_at)}</span>{decision.confidence != null && <b>{Math.round(Number(decision.confidence) * 100)}%</b>}</div>
                </div>
              ))}
              {details && !details.decisions.length && <span className="inspector-empty">No decisions recorded.</span>}
            </InspectorSection>

            <InspectorSection title="Handoff history" count={details?.handoffs?.length || 0}>
              {(details?.handoffs || []).map((handoff) => (
                <div className="audit-row" key={handoff.id}>
                  <div><strong>{label(handoff.action)}</strong><span>{handoff.reason}</span></div>
                  <div><span>{dateTime(handoff.created_at)}</span><b>{label(handoff.new_mode)}</b></div>
                </div>
              ))}
              {details && !details.handoffs.length && <span className="inspector-empty">No handoffs yet.</span>}
            </InspectorSection>
          </aside>
        </div>
      )}
    </main>
  );
}

function InspectorSection({ title, count, tone = "", children }) {
  return (
    <details className={`panel inspector-section ${tone}`} open>
      <summary><span>{title}</span><b>{count}</b></summary>
      <div className="inspector-section-body">{children}</div>
    </details>
  );
}
