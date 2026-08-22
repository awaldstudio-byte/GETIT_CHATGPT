"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { label } from "../../lib/format";
import MessageDeliveryStatus from "./MessageDeliveryStatus";

const GROUPS = {
  customer: { title: "Customers", singular: "customer", empty: "No customer chats yet" },
  driver: { title: "Drivers", singular: "driver", empty: "No driver chats yet" },
  shop: { title: "Shops", singular: "shop", empty: "No shop chats yet" },
};

const compactTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { day: "2-digit", month: "short" });
};

const preview = (conversation) =>
  conversation.last_message_body ||
  (conversation.last_message_type ? `[${label(conversation.last_message_type)}]` : "Chat ready");

const initials = (name) => String(name || "G")
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0])
  .join("")
  .toUpperCase();

const attentionScore = (conversation) => conversation.requires_attention
  ? Math.max(
      1,
      Number(conversation.unread_count || 0),
      Number(conversation.open_incident_count || 0),
      Number(conversation.manual_review_count || 0),
    )
  : 0;

function ChatIcon({ type }) {
  if (type === "driver") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6h11v10H3zM14 10h4l3 3v3h-7zM6.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
      </svg>
    );
  }
  if (type === "shop") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m4 4-2 6c0 1.4 1.1 2.5 2.5 2.5S7 11.4 7 10c0 1.4 1.1 2.5 2.5 2.5S12 11.4 12 10c0 1.4 1.1 2.5 2.5 2.5S17 11.4 17 10c0 1.4 1.1 2.5 2.5 2.5S22 11.4 22 10l-2-6H4Zm1 9.5V21h14v-7.5a4 4 0 0 1-2-.8 4 4 0 0 1-5 0 4 4 0 0 1-5 0 4 4 0 0 1-2 .8Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.7 1.5 5.1 3.8 6.6L5 22l4.2-2.2c.9.2 1.8.3 2.8.3 5.5 0 10-3.8 10-8.6S17.5 3 12 3Z" />
    </svg>
  );
}

function useAttentionSound(totalAttention) {
  const previousRef = useRef(null);
  const audioRef = useRef(null);
  const armedRef = useRef(false);
  const [soundReady, setSoundReady] = useState(false);

  useEffect(() => {
    const arm = () => {
      armedRef.current = true;
      setSoundReady(true);
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
      audioRef.current?.close?.().catch?.(() => {});
    };
  }, []);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = totalAttention;
    if (previous == null || totalAttention <= previous || !armedRef.current) return;

    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = audioRef.current || new AudioContext();
      audioRef.current = context;
      context.resume?.();
      const now = context.currentTime;
      [0, 0.17].forEach((offset, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(index ? 880 : 660, now + offset);
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.15);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + 0.17);
      });
    } catch {
      // The visible red badge remains authoritative if the browser blocks sound.
    }
  }, [totalAttention]);

  return soundReady;
}

export default function FloatingChatDock({ data, api, onError, onToast, onNavigate, realtimeRevision = 0 }) {
  const conversations = data.messagingInbox || [];
  const directory = data.messagingDirectory || [];
  const [openType, setOpenType] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [details, setDetails] = useState(null);
  const [search, setSearch] = useState("");
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connectShopId, setConnectShopId] = useState(null);
  const [shopPhone, setShopPhone] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const markedReadRef = useRef(new Map());
  const providerReadRef = useRef(new Map());
  const threadEndRef = useRef(null);
  const typingSentAtRef = useRef(0);

  const grouped = useMemo(() => Object.fromEntries(
    Object.keys(GROUPS).map((type) => [type, conversations.filter((item) => (item.participant_type || "customer") === type)]),
  ), [conversations]);

  const stats = useMemo(() => Object.fromEntries(
    Object.keys(GROUPS).map((type) => {
      const items = grouped[type];
      const unread = items.reduce((sum, item) => sum + Number(item.unread_count || 0), 0);
      const attention = items.reduce((sum, item) => sum + attentionScore(item), 0);
      return [type, { unread, attention, count: attention || unread }];
    }),
  ), [grouped]);

  const totalAttention = Object.values(stats).reduce((sum, item) => sum + item.attention, 0);
  const soundReady = useAttentionSound(totalAttention);
  const selected = conversations.find((item) => item.conversation_id === selectedId) || null;

  const visibleChats = useMemo(() => {
    if (!openType) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return grouped[openType];
    return grouped[openType].filter((item) =>
      `${item.participant_name || item.customer_name} ${item.participant_phone || item.customer_phone} ${preview(item)}`
        .toLowerCase()
        .includes(needle),
    );
  }, [grouped, openType, search]);

  const availableContacts = useMemo(() => {
    if (!openType || openType === "customer") return [];
    const conversationIds = new Set(grouped[openType].map((item) => item.conversation_id));
    return directory.filter((item) => item.participant_type === openType && !conversationIds.has(item.conversation_id));
  }, [directory, grouped, openType]);

  const loadConversation = useCallback(async () => {
    if (!selectedId || !api) {
      setDetails(null);
      return;
    }
    setLoading(true);
    try {
      const conversation = selected || { conversation_id: selectedId, customer_id: null };
      const next = await api.queries.messagingConversation(conversation.conversation_id, conversation.customer_id);
      setDetails(next);
      const lastMessageId = next.messages.at(-1)?.id || null;
      const marked = markedReadRef.current.get(conversation.conversation_id);
      if (lastMessageId && marked !== lastMessageId) {
        markedReadRef.current.set(conversation.conversation_id, lastMessageId);
        await api.actions.markMessagingRead(conversation.conversation_id, lastMessageId);
      }
      const lastInbound = [...next.messages].reverse().find((message) => message.direction === "inbound" && message.provider_message_id);
      if (lastInbound?.provider_message_id && providerReadRef.current.get(conversation.conversation_id) !== lastInbound.provider_message_id) {
        providerReadRef.current.set(conversation.conversation_id, lastInbound.provider_message_id);
        api.actions.sendMessagingPresence(lastInbound.provider_message_id, false).catch(() => {});
      }
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [api, onError, selected, selectedId]);

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

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [details?.messages?.length]);

  useEffect(() => {
    setMenuOpen(false);
    if (!openType) {
      setSelectedId(null);
      setDetails(null);
      setSearch("");
      setConnectShopId(null);
      setShopPhone("");
    }
  }, [openType]);

  useEffect(() => setMenuOpen(false), [selectedId]);

  const toggleGroup = (type) => {
    if (openType === type) {
      setOpenType(null);
      return;
    }
    setOpenType(type);
    setSelectedId(null);
    setDetails(null);
    setSearch("");
  };

  const startParticipantChat = async (item) => {
    if (!api || busy) return;
    const phone = item.participant_type === "shop" ? shopPhone.trim() : item.participant_phone;
    if (item.participant_type === "shop" && !/^\+?[0-9 ()-]{8,20}$/.test(phone)) {
      onError(new Error("Enter the shop's WhatsApp number, including the country code."));
      return;
    }
    setBusy(true);
    try {
      const result = await api.actions.openMessagingParticipant(item.participant_type, item.participant_id, phone || null);
      const opened = Array.isArray(result) ? result[0] : result;
      if (!opened?.conversation_id) throw new Error("The chat could not be opened.");
      setSelectedId(opened.conversation_id);
      setConnectShopId(null);
      setShopPhone("");
      onToast(`${item.participant_name} chat opened`);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const changeMode = async (nextMode) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await api.actions.setMessagingMode(
        selected.conversation_id,
        nextMode,
        {
          automation: "Conversation automation enabled from floating chat dock",
          human: "Staff takeover from floating chat dock",
          paused: "Conversation paused from floating chat dock",
          dry_run: "Conversation released to dry run from floating chat dock",
        }[nextMode],
        selected.version,
      );
      onToast({
        automation: "AI automation is on for this chat",
        human: "Chat is now with staff",
        paused: "Replies paused",
        dry_run: "Chat is in dry run",
      }[nextMode]);
      await loadConversation();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const copyParticipantNumber = async () => {
    const phone = selected?.participant_phone || selected?.customer_phone;
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
    const name = selected.participant_name || selected.customer_name || "this chat";
    if (!window.confirm(`Start fresh with ${name}?\n\nThis clears the visible chat and AI memory, including any active order draft.`)) return;
    setBusy(true);
    setMenuOpen(false);
    try {
      await api.actions.resetMessagingConversation(
        selected.conversation_id,
        selected.version,
        "Fresh start requested from floating chat dock",
      );
      markedReadRef.current.delete(selected.conversation_id);
      providerReadRef.current.delete(selected.conversation_id);
      setComposer("");
      setDetails({ messages: [], decisions: [], handoffs: [], incidents: [], draft: null, recentOrders: details?.recentOrders || [] });
      onToast("Chat cleared. The next message starts fresh.");
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

  const sendReply = async (event) => {
    event.preventDefault();
    const body = composer.trim();
    if (!selectedId || !body || busy) return;
    setBusy(true);
    try {
      await api.actions.sendStaffMessage(
        selectedId,
        body,
        `floating-dock:${selectedId}:${crypto.randomUUID()}`,
      );
      setComposer("");
      onToast("Message queued safely");
      await loadConversation();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="floating-chat-dock" aria-label="Live chats">
      {openType && (
        <section className="chat-dock-panel" aria-label={`${GROUPS[openType].title} chats`}>
          {!selectedId ? (
            <>
              <header className="chat-dock-header">
                <div className={`chat-dock-heading-icon ${openType}`}><ChatIcon type={openType} /></div>
                <div>
                  <span>Getit messages</span>
                  <strong>{GROUPS[openType].title}</strong>
                </div>
                <div className="chat-dock-header-actions">
                  <span className={`sound-state ${soundReady ? "ready" : ""}`} title={soundReady ? "Attention sound is on" : "Sound turns on after the first click"}>
                    {soundReady ? "Sound on" : "Sound ready"}
                  </span>
                  <button type="button" onClick={() => setOpenType(null)} aria-label="Close chats">×</button>
                </div>
              </header>

              <div className="chat-dock-search">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" /></svg>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${GROUPS[openType].title.toLowerCase()}`} />
              </div>

              <div className="chat-dock-list">
                {visibleChats.map((conversation) => {
                  const red = attentionScore(conversation);
                  const unread = Number(conversation.unread_count || 0);
                  return (
                    <button type="button" className={`chat-list-row ${red ? "attention" : ""}`} key={conversation.conversation_id} onClick={() => setSelectedId(conversation.conversation_id)}>
                      <span className={`chat-avatar ${openType}`}>{initials(conversation.participant_name || conversation.customer_name)}</span>
                      <span className="chat-list-copy">
                        <span><strong>{conversation.participant_name || conversation.customer_name}</strong><time>{compactTime(conversation.last_message_at)}</time></span>
                        <span><small>{preview(conversation)}</small>{red ? <b className="mini-chat-count attention">{red}</b> : unread > 0 ? <b className="mini-chat-count unread">{unread}</b> : null}</span>
                      </span>
                    </button>
                  );
                })}

                {!visibleChats.length && (
                  <div className="chat-list-empty">
                    <ChatIcon type={openType} />
                    <strong>{GROUPS[openType].empty}</strong>
                    <span>New messages will stay here and update live.</span>
                  </div>
                )}

                {availableContacts.length > 0 && !search && (
                  <div className="chat-directory">
                    <div className="chat-directory-title">Start a new chat</div>
                    {availableContacts.map((item) => (
                      <div className="chat-directory-row" key={`${item.participant_type}:${item.participant_id}`}>
                        <span className={`chat-avatar small ${openType}`}>{initials(item.participant_name)}</span>
                        <span><strong>{item.participant_name}</strong><small>{item.participant_phone || item.participant_status || "WhatsApp number needed"}</small></span>
                        {item.participant_type === "shop" && connectShopId === item.participant_id ? (
                          <div className="shop-connect-form">
                            <input value={shopPhone} onChange={(event) => setShopPhone(event.target.value)} placeholder="+27 WhatsApp number" autoFocus />
                            <button type="button" onClick={() => startParticipantChat(item)} disabled={busy}>Open</button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => item.participant_type === "shop" ? setConnectShopId(item.participant_id) : startParticipantChat(item)}
                            disabled={busy}
                          >Chat</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <footer className="chat-dock-legend">
                <span><i className="blue" /> New message</span>
                <span><i className="red" /> Needs your attention</span>
                {openType === "customer" && <button type="button" onClick={() => { onNavigate("messaging"); setOpenType(null); }}>Open full inbox</button>}
              </footer>
            </>
          ) : (
            <>
              <header className="chat-thread-mini-header">
                <button type="button" onClick={() => { setSelectedId(null); setDetails(null); setMenuOpen(false); }} aria-label="Back to chats">←</button>
                <span className={`chat-avatar ${openType}`}>{initials(selected?.participant_name || selected?.customer_name)}</span>
                <div><strong>{selected?.participant_name || selected?.customer_name || "Chat"}</strong><span>{GROUPS[openType].singular} · {selected?.mode === "human" ? "Staff chat" : selected?.mode === "automation" ? "AI active" : label(selected?.mode || "loading")}</span></div>
                <div className="mini-chat-header-actions">
                  <div className="chat-overflow-menu">
                    <button type="button" className="chat-overflow-trigger" onClick={() => setMenuOpen((open) => !open)} aria-label="More chat actions" aria-expanded={menuOpen}>•••</button>
                    {menuOpen && (
                      <div className="chat-overflow-popover compact" role="menu">
                        {selected?.mode !== "human" && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); changeMode("human"); }}>Take over chat</button>}
                        {selected?.mode !== "automation" && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); changeMode("automation"); }}>Enable AI</button>}
                        {selected?.mode !== "paused" && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); changeMode("paused"); }}>Pause replies</button>}
                        {(selected?.participant_phone || selected?.customer_phone) && <button type="button" role="menuitem" onClick={copyParticipantNumber}>Copy WhatsApp number</button>}
                        <button type="button" role="menuitem" className="danger" onClick={clearConversation}>Clear chat & start fresh</button>
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={() => { setOpenType(null); setMenuOpen(false); }} aria-label="Close chats">×</button>
                </div>
              </header>

              <div className="mini-message-thread" aria-live="polite">
                {loading && !details ? <span className="mini-thread-loading">Opening chat…</span> : null}
                {(details?.messages || []).map((message) => (
                  <article className={`mini-message ${message.direction}`} key={message.id}>
                    <p>{message.body || `[${label(message.message_type)}]`}</p>
                    <span>{compactTime(message.created_at)} <MessageDeliveryStatus message={message} compact /></span>
                  </article>
                ))}
                {details && !details.messages.length && <span className="mini-thread-loading">No messages yet. Start the conversation below.</span>}
                <div ref={threadEndRef} />
              </div>

              {selected ? (
                <div className={`mini-mode-switch ${selected.mode === "automation" ? "automation" : "staff"}`}>
                  <span>{selected.mode === "automation" ? "AI is answering this chat" : selected.mode === "human" ? "Mum is answering this chat" : "AI is currently off"}</span>
                  {selected.mode !== "automation" && <button type="button" className="automation-button" onClick={() => changeMode("automation")} disabled={busy}>Enable AI</button>}
                  {selected.mode !== "human" && <button type="button" onClick={() => changeMode("human")} disabled={busy}>Take over</button>}
                </div>
              ) : null}

              <form className="mini-chat-composer" onSubmit={sendReply}>
                <textarea
                  value={composer}
                  onChange={handleComposerChange}
                  placeholder={selected?.mode === "human" ? "Type a message" : "Take over to reply"}
                  disabled={!selected || selected.mode !== "human" || busy}
                  rows={2}
                  maxLength={4096}
                />
                <button type="submit" disabled={!selected || selected.mode !== "human" || !composer.trim() || busy} aria-label="Send message">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h9" /></svg>
                </button>
              </form>
            </>
          )}
        </section>
      )}

      <div className="chat-dock-bubbles">
        {Object.keys(GROUPS).map((type) => {
          const group = stats[type];
          const tone = group.attention ? "attention" : group.unread ? "unread" : "";
          return (
            <button
              type="button"
              key={type}
              className={`chat-dock-bubble ${type} ${tone} ${openType === type ? "active" : ""}`}
              onClick={() => toggleGroup(type)}
              aria-label={`${GROUPS[type].title}${group.count ? `, ${group.count} notifications` : ""}`}
              title={GROUPS[type].title}
            >
              <ChatIcon type={type} />
              {group.count > 0 && <b className={tone}>{group.count > 99 ? "99+" : group.count}</b>}
              <span>{GROUPS[type].title}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
