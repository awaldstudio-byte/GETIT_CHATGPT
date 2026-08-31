"use client";

import { useState } from "react";
import { dateTime, label } from "../../lib/format";

const entryTitle = (entry) => entry.entry_type === "partner_company"
  ? entry.company_name || entry.name || "Unnamed company"
  : entry.name || entry.phone || "Waiting-list contact";

const entryKind = (entry) => entry.entry_type === "partner_company" ? "Shop / company lead" : "Customer waitlist";

export default function LaunchQueue({ data, onError, onToast, onNavigate }) {
  const entries = data.launchQueue || [];
  const [filter, setFilter] = useState("active_waitlist");

  const activeWaitlist = entries.filter((entry) => entry.entry_type === "customer_waitlist" && entry.status === "active");
  const protectedHistory = entries.filter((entry) => entry.entry_type === "customer_waitlist" && entry.confirmation_status === "suppressed");
  const removedWaitlist = entries.filter((entry) => entry.entry_type === "customer_waitlist" && entry.status === "removed");
  const partnerLeads = entries.filter((entry) => entry.entry_type === "partner_company");

  const visible = filter === "all"
    ? entries
    : filter === "partners"
      ? partnerLeads
      : filter === "protected"
        ? protectedHistory
        : activeWaitlist;

  const copyPhone = async (phone) => {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      onToast("WhatsApp number copied");
    } catch (error) {
      onError(error);
    }
  };

  return (
    <main className="dashboard-shell launch-queue-page">
      <section className="launch-queue-hero">
        <div>
          <span className="eyebrow">Controlled launch</span>
          <h1>Launch queue</h1>
          <p>The customer waiting list and shop/company leads in one authoritative view.</p>
        </div>
        <button type="button" className="small-button" onClick={() => onNavigate("messaging")}>Open messaging</button>
      </section>

      <section className="launch-queue-metrics" aria-label="Launch queue totals">
        <article><span>Active waitlist</span><strong>{activeWaitlist.length}</strong></article>
        <article><span>Historical sends protected</span><strong>{protectedHistory.length}</strong></article>
        <article><span>Removed</span><strong>{removedWaitlist.length}</strong></article>
        <article><span>Shop / company leads</span><strong>{partnerLeads.length}</strong></article>
      </section>

      <section className="panel launch-queue-panel">
        <header className="launch-queue-toolbar">
          <div>
            <h2>People and partners</h2>
            <small>Viewing this page never sends a WhatsApp message.</small>
          </div>
          <div className="messaging-filters" role="group" aria-label="Launch queue filter">
            {[
              ["active_waitlist", "Active waitlist"],
              ["partners", "Shop leads"],
              ["protected", "Protected history"],
              ["all", "All"],
            ].map(([value, text]) => (
              <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{text}</button>
            ))}
          </div>
        </header>

        {protectedHistory.length > 0 && (
          <div className="launch-queue-safety">
            Historical confirmations remain suppressed by design. Enabling AI on an old chat does not re-add the person or send a duplicate waiting-list message.
          </div>
        )}

        <div className="launch-queue-list">
          {visible.map((entry) => (
            <article className="launch-queue-entry" key={`${entry.entry_type}:${entry.id}`}>
              <div className="launch-queue-entry-main">
                <div className="launch-queue-entry-heading">
                  <div>
                    <span className="eyebrow">{entryKind(entry)}</span>
                    <h3>{entryTitle(entry)}</h3>
                  </div>
                  <span className={`tag launch-status ${entry.status}`}>{label(entry.status)}</span>
                </div>
                <dl>
                  <div><dt>WhatsApp</dt><dd>{entry.phone || "Not recorded"}</dd></div>
                  <div><dt>Town</dt><dd>{entry.town || "Not recorded"}</dd></div>
                  <div><dt>Joined</dt><dd>{dateTime(entry.joined_at)}</dd></div>
                  <div><dt>Source</dt><dd>{label(entry.source || "unknown")}</dd></div>
                  {entry.entry_type === "customer_waitlist" && <div><dt>Confirmation</dt><dd>{label(entry.confirmation_status || "pending")}</dd></div>}
                  {entry.entry_type === "customer_waitlist" && <div><dt>Requests</dt><dd>{Number(entry.request_count || 1)}</dd></div>}
                  {entry.entry_type === "partner_company" && <div><dt>Form pages</dt><dd>{Number(entry.form_page_count || 0)}</dd></div>}
                </dl>
              </div>
              <div className="launch-queue-entry-actions">
                {entry.phone && <button type="button" className="ghost-button" onClick={() => copyPhone(entry.phone)}>Copy number</button>}
                {entry.conversation_id && <button type="button" className="small-button" onClick={() => onNavigate("messaging")}>View chats</button>}
              </div>
            </article>
          ))}
          {!visible.length && (
            <div className="launch-queue-empty">
              <strong>Nothing in this view</strong>
              <span>New entries will appear here from the authoritative launch queue.</span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
