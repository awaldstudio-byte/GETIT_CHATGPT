"use client";

import { useEffect, useMemo, useState } from "react";
import { label } from "../../lib/format";

const when = (value) => value
  ? new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "Not yet";

const applicationName = (item) => item.application_type === "shop"
  ? item.business_name || "Unnamed shop"
  : item.applicant_name || "Driver applicant";

export default function PartnerApplications({ data, api, onError, onToast, onNavigate }) {
  const applications = data.partnerApplications || [];
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("open");
  const [selectedId, setSelectedId] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => applications.filter((item) => {
    const typeMatch = type === "all" || item.application_type === type;
    const statusMatch = status === "all"
      || (status === "open" ? ["submitted", "reviewing"].includes(item.status) : item.status === status);
    return typeMatch && statusMatch;
  }), [applications, type, status]);

  const selected = applications.find((item) => item.id === selectedId) || filtered[0] || null;

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  useEffect(() => {
    setNote(selected?.review_note || "");
  }, [selected?.id, selected?.review_note]);

  const changeStatus = async (nextStatus) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await api.actions.reviewPartnerApplication(selected.id, nextStatus, note, selected.version);
      onToast(nextStatus === "approved" ? "Application approved for onboarding" : nextStatus === "rejected" ? "Application declined" : "Application marked for review");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const counts = {
    open: applications.filter((item) => ["submitted", "reviewing"].includes(item.status)).length,
    shop: applications.filter((item) => item.application_type === "shop" && ["submitted", "reviewing"].includes(item.status)).length,
    driver: applications.filter((item) => item.application_type === "driver" && ["submitted", "reviewing"].includes(item.status)).length,
  };

  return (
    <main className="dashboard-shell partner-page">
      <section className="partner-heading">
        <div>
          <span className="eyebrow">WhatsApp applications</span>
          <h1>Shop manager</h1>
          <p>Review people who registered a shop or applied to drive from WhatsApp.</p>
        </div>
        <div className="partner-stats">
          <span><b>{counts.shop}</b> Shops waiting</span>
          <span><b>{counts.driver}</b> Drivers waiting</span>
        </div>
      </section>

      <div className="partner-toolbar">
        <div className="partner-filters" role="group" aria-label="Application type">
          {[['all','All'],['shop','Shops'],['driver','Drivers']].map(([value, text]) => (
            <button type="button" key={value} className={type === value ? "active" : ""} onClick={() => setType(value)}>{text}</button>
          ))}
        </div>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Application status">
          <option value="open">Waiting for review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Declined</option>
          <option value="all">All applications</option>
        </select>
      </div>

      {applications.length === 0 ? (
        <section className="panel partner-empty">
          <div className="empty-orbit">+</div>
          <strong>No applications yet</strong>
          <span>Completed WhatsApp shop and driver forms will appear here automatically.</span>
        </section>
      ) : (
        <div className="partner-layout">
          <section className="panel partner-list">
            <header><strong>{filtered.length} application{filtered.length === 1 ? "" : "s"}</strong><span>{counts.open} waiting</span></header>
            <div>
              {filtered.map((item) => (
                <button type="button" key={item.id} className={`partner-row ${selected?.id === item.id ? "active" : ""}`} onClick={() => setSelectedId(item.id)}>
                  <span className={`partner-type ${item.application_type}`}>{item.application_type === "shop" ? "Shop" : "Driver"}</span>
                  <span className="partner-row-copy">
                    <strong>{applicationName(item)}</strong>
                    <small>{item.applicant_name || item.applicant_phone || "Name not supplied"}</small>
                  </span>
                  <span className={`tag application-${item.status}`}>{item.status === "submitted" ? "New" : label(item.status)}</span>
                </button>
              ))}
              {!filtered.length && <p className="partner-no-results">No applications match this filter.</p>}
            </div>
          </section>

          {selected && (
            <section className="panel partner-detail">
              <header>
                <div>
                  <span className="eyebrow">{selected.application_type === "shop" ? "Shop registration" : "Driver application"}</span>
                  <h2>{applicationName(selected)}</h2>
                </div>
                <span className={`tag application-${selected.status}`}>{selected.status === "submitted" ? "New" : label(selected.status)}</span>
              </header>

              <div className="partner-detail-grid">
                <div><span>Applicant</span><strong>{selected.applicant_name || "Not supplied"}</strong></div>
                <div><span>WhatsApp</span><strong>{selected.applicant_phone || "Not supplied"}</strong></div>
                {selected.application_type === "shop" ? (
                  <>
                    <div><span>Shop name</span><strong>{selected.business_name || "Not supplied"}</strong></div>
                    <div><span>What they sell</span><strong>{selected.business_type || "Not supplied"}</strong></div>
                  </>
                ) : (
                  <>
                    <div><span>Own working motorbike</span><strong>{selected.has_own_bike ? "Yes" : "Not confirmed"}</strong></div>
                    <div><span>Availability</span><strong>{selected.availability || "Not supplied"}</strong></div>
                  </>
                )}
                <div className="wide"><span>Location</span><strong>{selected.location_text || "Not supplied"}</strong></div>
                <div><span>Submitted</span><strong>{when(selected.submitted_at)}</strong></div>
                <div><span>Last updated</span><strong>{when(selected.updated_at)}</strong></div>
              </div>

              {selected.application_type === "driver" && (
                <div className="partner-warning">The applicant was told that they need their own working motorbike and that applying does not guarantee work while Getit is launching.</div>
              )}
              <div className="partner-safety-note">Approving here records the review decision only. It does not create or activate a live shop or driver.</div>

              <label className="partner-review-note">
                <span>Private review note</span>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add checks, follow-up details or a reason…" maxLength={2000} />
              </label>

              <div className="partner-actions">
                <button type="button" className="ghost-button" onClick={() => onNavigate("messaging")}>Open messaging</button>
                <button type="button" className="small-button" disabled={busy} onClick={() => changeStatus("reviewing")}>Mark reviewing</button>
                <button type="button" className="small-button danger-button" disabled={busy} onClick={() => changeStatus("rejected")}>Decline</button>
                <button type="button" className="primary-button" disabled={busy} onClick={() => changeStatus("approved")}>Approve for onboarding</button>
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
