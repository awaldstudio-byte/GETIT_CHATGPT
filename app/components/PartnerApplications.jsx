"use client";

import { useEffect, useMemo, useState } from "react";
import { label } from "../../lib/format";
import { supabase } from "../../lib/supabase";
import MediaAttachment from "./MediaAttachment";

const when = (value) => value
  ? new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "Not yet";

const applicationName = (item) => item.application_type === "shop"
  ? item.business_name || "Unnamed shop"
  : item.applicant_name || "Driver applicant";

const requirementLabel = {
  required: "Required",
  conditional: "Only if applicable",
  optional: "Optional",
};

const sectionLabel = {
  quick_application: "Quick application",
  shop_profile: "Shop profile",
  hours: "Trading hours",
  catalogue: "Catalogue preferences",
  agreement: "Agreement",
};

const fieldDisplayValue = (value) => {
  if (value?.value_text) return value.value_text;
  const structured = value?.value_json;
  if (Array.isArray(structured)) return structured.join("; ");
  if (Array.isArray(structured?.checked_boxes)) return structured.checked_boxes.join("; ");
  if (structured && typeof structured === "object") {
    return Object.entries(structured)
      .map(([key, item]) => `${key.replaceAll("_", " ")}: ${Array.isArray(item) ? item.join(", ") : String(item)}`)
      .join("; ");
  }
  return "";
};

function PartnerFieldReviewRow({ applicationId, definition, value, api, onError, onToast }) {
  const originalText = fieldDisplayValue(value);
  const [draft, setDraft] = useState(originalText);
  const [note, setNote] = useState(value?.staff_note || "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(fieldDisplayValue(value));
    setNote(value?.staff_note || "");
  }, [value?.version, value?.value_text, value?.value_json, value?.staff_note]);

  const save = async (verificationStatus) => {
    if (busy) return;
    if (verificationStatus === "verified" && !draft.trim()) {
      onError(new Error("Add the value before verifying this field."));
      return;
    }
    setBusy(true);
    try {
      await api.actions.reviewPartnerApplicationField({
        applicationId,
        fieldKey: definition.field_key,
        valueText: draft,
        valueJson: draft === originalText ? value?.value_json || null : null,
        verificationStatus,
        staffNote: note,
        expectedVersion: value?.version || 0,
      });
      onToast(verificationStatus === "verified" ? `${definition.field_label} verified` : `${definition.field_label} rejected`);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const stateText = value
    ? value.verification_status === "verified" ? "Verified"
      : value.verification_status === "rejected" ? "Rejected"
        : `Check extracted value${value.confidence != null ? ` · ${Math.round(Number(value.confidence) * 100)}% confidence` : ""}`
    : definition.requirement_level === "optional" ? "Optional — not supplied"
      : definition.requirement_level === "conditional" ? "Only if applicable — not supplied"
        : "Required — no value extracted";

  return (
    <article className={`partner-field-row ${value?.verification_status || "missing"}`}>
      <div className="partner-field-heading">
        <div>
          <strong>{definition.field_label}</strong>
          <small>{stateText}</small>
        </div>
        <span className={`partner-requirement ${definition.requirement_level}`}>{requirementLabel[definition.requirement_level]}</span>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={definition.requirement_level === "optional" ? "Leave blank if they did not supply it" : "Enter or correct the value"}
        maxLength={4000}
        rows={draft.length > 140 ? 3 : 2}
      />
      {value?.evidence_text && <small className="partner-field-evidence">Source: {value.evidence_text}{value.source_page ? ` · page ${value.source_page}` : ""}</small>}
      {(value || draft.trim()) && (
        <div className="partner-field-actions">
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional staff note" maxLength={2000} />
          {value && <button type="button" className="ghost-button" disabled={busy} onClick={() => save("rejected")}>Reject</button>}
          <button type="button" className="small-button" disabled={busy || !draft.trim()} onClick={() => save("verified")}>{busy ? "Saving…" : "Save & verify"}</button>
        </div>
      )}
    </article>
  );
}

function OnboardingRequirementRow({ item, api, onError, onToast }) {
  const [status, setStatus] = useState(item.status);
  const [value, setValue] = useState(item.current_value || "");
  const [note, setNote] = useState(item.staff_note || "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStatus(item.status);
    setValue(item.current_value || "");
    setNote(item.staff_note || "");
  }, [item.version, item.status, item.current_value, item.staff_note]);

  const save = async () => {
    setBusy(true);
    try {
      await api.actions.updatePartnerOnboardingRequirement({
        requirementId: item.id,
        status,
        currentValue: value,
        staffNote: note,
        expectedVersion: item.version,
      });
      onToast("Onboarding checklist updated");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`onboarding-requirement ${item.requirement_level}`}>
      <header>
        <div><strong>{item.title}</strong><small>{requirementLabel[item.requirement_level]}</small></div>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label={`${item.title} status`}>
          <option value="not_started">Not started</option>
          <option value="requested">Requested</option>
          <option value="needs_guidance">Customer needs guidance</option>
          <option value="partial">Partly received</option>
          <option value="received_pending_review">Received — check it</option>
          <option value="verified">Verified</option>
          <option value="not_applicable">Not applicable</option>
          <option value="blocked">Blocked</option>
          <option value="completed">Completed</option>
        </select>
      </header>
      {item.guidance && <p>{item.guidance}</p>}
      <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Current answer or progress" maxLength={4000} />
      <div className="partner-field-actions">
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Private staff note" maxLength={2000} />
        <button type="button" className="small-button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </article>
  );
}

export default function PartnerApplications({ data, api, onError, onToast, onNavigate }) {
  const applications = data.partnerApplications || [];
  const catalogueSubmissions = data.partnerCatalogueSubmissions || [];
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("open");
  const [selectedId, setSelectedId] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(null);
  const [showOptional, setShowOptional] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [instructionLevel, setInstructionLevel] = useState("optional");

  const filtered = useMemo(() => applications.filter((item) => {
    const typeMatch = type === "all" || item.application_type === type;
    const statusMatch = status === "all"
      || (status === "open" ? ["submitted", "reviewing"].includes(item.status) : item.status === status);
    return typeMatch && statusMatch;
  }), [applications, type, status]);

  const selected = applications.find((item) => item.id === selectedId) || filtered[0] || null;
  const selectedCatalogues = selected
    ? catalogueSubmissions.filter((item) => item.application_id === selected.id)
    : [];
  const selectedFiles = selected
    ? (data.partnerApplicationFiles || []).filter((item) => item.application_id === selected.id)
    : [];
  const selectedDefinitions = selected
    ? (data.partnerApplicationFieldDefinitions || []).filter((item) => item.application_type === selected.application_type)
    : [];
  const selectedValues = selected
    ? (data.partnerApplicationFieldValues || []).filter((item) => item.application_id === selected.id)
    : [];
  const selectedValueMap = new Map(selectedValues.map((item) => [item.field_key, item]));
  const selectedExtractionJob = selected
    ? (data.partnerApplicationExtractionJobs || []).find((item) => item.application_id === selected.id) || null
    : null;
  const selectedRequirements = selected
    ? (data.partnerOnboardingRequirements || []).filter((item) => item.application_id === selected.id)
    : [];
  const selectedConversation = selected
    ? (data.messagingInbox || []).find((item) => item.conversation_id === selected.conversation_id) || null
    : null;
  const onboardingStarted = selected?.answers?.onboarding?.customer_messaging_started === true;
  const requiredDefinitions = selectedDefinitions.filter((item) => item.requirement_level === "required");
  const unresolvedRequired = requiredDefinitions.filter((item) => selectedValueMap.get(item.field_key)?.verification_status !== "verified");
  const visibleDefinitions = selectedDefinitions.filter((item) => {
    if (item.requirement_level !== "optional") return true;
    return showOptional || selectedValueMap.has(item.field_key);
  });

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  useEffect(() => {
    setNote(selected?.review_note || "");
  }, [selected?.id, selected?.review_note]);

  const changeStatus = async (nextStatus) => {
    if (!selected || busy) return;
    if (!note.trim()) {
      onError(new Error("Add a private review note before changing this application."));
      return;
    }
    setBusy(true);
    try {
      await api.actions.reviewPartnerApplication(selected.id, nextStatus, note, selected.version);
      if (nextStatus === "approved") setStatus("approved");
      if (nextStatus === "rejected") setStatus("rejected");
      onToast(nextStatus === "approved" ? "Application approved for onboarding" : nextStatus === "rejected" ? "Application declined" : "Application marked for review");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const queueExtraction = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await api.actions.queuePartnerApplicationExtraction(selected.id);
      onToast("Form extraction queued — no customer message was sent");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const addInstruction = async () => {
    if (!selected || !instruction.trim() || busy) return;
    setBusy(true);
    try {
      await api.actions.addPartnerOnboardingRequirement({
        applicationId: selected.id,
        title: instruction,
        requirementLevel: instructionLevel,
        guidance: "Answer the shop's questions first, then return naturally to this item. Ask one small relevant question at a time.",
      });
      setInstruction("");
      setInstructionLevel("optional");
      onToast("Onboarding instruction added — it has not been sent to the shop");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const startGuidedOnboarding = async () => {
    if (!selected || !selectedConversation || busy || onboardingStarted) return;
    const confirmed = window.confirm(
      `Start live guided onboarding with ${applicationName(selected)}?\n\nThis sends one approval message, releases only this conversation to automation, and lets the AI collect one onboarding item at a time. AI-captured answers stay pending staff review and cannot activate the shop.`,
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.actions.startPartnerGuidedOnboarding({
        applicationId: selected.id,
        expectedApplicationVersion: selected.version,
        expectedConversationVersion: selectedConversation.version,
      });
      onToast("Guided onboarding started — the approval message is safely queued");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const downloadCatalogue = async (catalogue) => {
    if (!catalogue?.storage_bucket || !catalogue?.storage_path || downloadBusy) return;
    setDownloadBusy(catalogue.id);
    try {
      const { data: signed, error } = await supabase.storage
        .from(catalogue.storage_bucket)
        .createSignedUrl(catalogue.storage_path, 300, {
          download: catalogue.original_file_name || "getit-partner-catalogue",
        });
      if (error || !signed?.signedUrl) throw error || new Error("Could not create a private download link.");
      window.open(signed.signedUrl, "_blank", "noopener,noreferrer");
      onToast("Private catalogue download opened. Treat shop files as untrusted until reviewed.");
    } catch (error) {
      onError(error);
    } finally {
      setDownloadBusy(null);
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
              {selected.application_type === "shop" && selectedCatalogues.length > 0 && (
                <div className="partner-catalogues">
                  <span className="eyebrow">Private catalogue intake</span>
                  {selectedCatalogues.map((catalogue) => (
                    <div className="partner-warning" key={catalogue.id}>
                      <strong>{catalogue.original_file_name || "Catalogue file"}</strong><br />
                      {catalogue.catalogue_kind ? `${label(catalogue.catalogue_kind)} · ` : ""}{label(catalogue.status)}
                      {catalogue.valid_from && catalogue.valid_to ? ` · ${catalogue.valid_from} to ${catalogue.valid_to}` : ""}
                      {catalogue.expected_refresh_on ? ` · next update expected ${catalogue.expected_refresh_on}` : ""}
                      {catalogue.upload_error_code ? ` · ${catalogue.upload_error_code}` : ""}
                      {catalogue.storage_path && (
                        <div className="partner-catalogue-actions">
                          <button type="button" className="small-button" disabled={downloadBusy === catalogue.id} onClick={() => downloadCatalogue(catalogue)}>
                            {downloadBusy === catalogue.id ? "Preparing…" : "Download privately"}
                          </button>
                          <button type="button" className="ghost-button" onClick={() => onNavigate("catalogue")}>Open catalogue manager</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <section className="partner-application-files">
                <div>
                  <span className="eyebrow">Application evidence</span>
                  <strong>{selectedFiles.length ? `${selectedFiles.length} secure file${selectedFiles.length === 1 ? "" : "s"}` : "No application file attached"}</strong>
                </div>
                {selectedFiles.length ? selectedFiles.map((file) => file.attachment ? (
                  <MediaAttachment key={file.id} attachment={file.attachment} compact />
                ) : (
                  <div className="partner-warning" key={file.id}>The application file link exists, but its attachment record could not be loaded.</div>
                )) : (
                  <div className="partner-warning">This submission came through the older WhatsApp field flow and has no PDF or photo evidence attached. Review it manually before any decision.</div>
                )}
              </section>
              {selected.application_type === "shop" && (
                <section className="partner-form-review">
                  <header>
                    <div>
                      <span className="eyebrow">Extracted application details</span>
                      <strong>{selectedValues.length ? `${selectedValues.length} field${selectedValues.length === 1 ? "" : "s"} ready to check` : "No fields extracted yet"}</strong>
                      <small>{unresolvedRequired.length} required field{unresolvedRequired.length === 1 ? "" : "s"} still need verification. Optional blanks do not block approval.</small>
                    </div>
                    <div className="partner-form-actions">
                      <button type="button" className="ghost-button" onClick={() => setShowOptional((value) => !value)}>{showOptional ? "Hide blank optional fields" : "Show all optional fields"}</button>
                      <button type="button" className="small-button" disabled={busy || selectedExtractionJob?.status === "processing" || selectedExtractionJob?.status === "pending"} onClick={queueExtraction}>
                        {selectedExtractionJob?.status === "processing" ? "Extracting…" : selectedExtractionJob?.status === "pending" ? "Extraction queued" : selectedValues.length ? "Extract again" : "Extract form details"}
                      </button>
                    </div>
                  </header>
                  {selectedExtractionJob?.status === "failed" && <div className="partner-warning">Extraction needs another try: {selectedExtractionJob.error_code || "the local document service did not complete"}.</div>}
                  {Object.entries(sectionLabel).map(([sectionKey, title]) => {
                    const sectionFields = visibleDefinitions.filter((item) => item.section_key === sectionKey);
                    if (!sectionFields.length) return null;
                    return (
                      <div className="partner-field-section" key={sectionKey}>
                        <h3>{title}</h3>
                        {sectionFields.map((definition) => (
                          <PartnerFieldReviewRow
                            key={definition.field_key}
                            applicationId={selected.id}
                            definition={definition}
                            value={selectedValueMap.get(definition.field_key)}
                            api={api}
                            onError={onError}
                            onToast={onToast}
                          />
                        ))}
                      </div>
                    );
                  })}
                </section>
              )}
              <div className="partner-safety-note">
                {selected.status === "approved"
                  ? "Approval is complete. Starting guided onboarding is a separate confirmed action: it sends one message and enables AI only for this shop. AI-captured answers remain pending staff review and cannot activate the shop."
                  : "Approval prepares a visible guided-onboarding checklist. It does not message the shop, activate it, publish a catalogue, or enable restricted products until staff separately starts guided onboarding."}
              </div>

              <label className="partner-review-note">
                <span>Private review note</span>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add checks, follow-up details or a reason…" maxLength={2000} />
              </label>

              <div className="partner-actions">
                <button type="button" className="ghost-button" onClick={() => onNavigate("messaging")}>Open messaging</button>
                {["submitted", "reviewing"].includes(selected.status) && <button type="button" className="small-button" disabled={busy || !note.trim()} onClick={() => changeStatus("reviewing")}>Mark reviewing</button>}
                {["submitted", "reviewing"].includes(selected.status) && <button type="button" className="small-button danger-button" disabled={busy || !note.trim()} onClick={() => changeStatus("rejected")}>Decline</button>}
                {["submitted", "reviewing"].includes(selected.status) && <button type="button" className="primary-button" disabled={busy || !note.trim() || (selected.application_type === "shop" && unresolvedRequired.length > 0)} onClick={() => changeStatus("approved")}>Approve & prepare onboarding</button>}
                {selected.status === "approved" && !onboardingStarted && <button type="button" className="primary-button automation-button" disabled={busy || !selectedConversation} onClick={startGuidedOnboarding}>Start guided onboarding</button>}
              </div>
              {selected.status === "approved" && !onboardingStarted && !selectedConversation && <div className="partner-warning">This application has no visible messaging conversation yet. Refresh or open Messaging before starting onboarding.</div>}

              {selectedRequirements.length > 0 && (
                <section className="partner-onboarding-workspace">
                  <header>
                    <div>
                      <span className="eyebrow">Guided onboarding</span>
                      <h3>Procedure checklist</h3>
                      <small>{selectedRequirements.filter((item) => item.requirement_level === "required" && !["verified","completed","not_applicable"].includes(item.status)).length} required item(s) remaining. Optional items never block progress.</small>
                    </div>
                    <span className={`tag ${onboardingStarted ? "application-approved" : "application-reviewing"}`}>{onboardingStarted ? "Guided onboarding live" : "No customer message started"}</span>
                  </header>
                  {selectedRequirements.map((item) => (
                    <OnboardingRequirementRow key={item.id} item={item} api={api} onError={onError} onToast={onToast} />
                  ))}
                  <div className="onboarding-instruction">
                    <strong>Add an onboarding instruction</strong>
                    <p>This is separate from the private review note. It becomes a tracked procedure item; nothing is sent automatically yet.</p>
                    <div>
                      <input value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Example: Ask whether they want to share a menu, photos or a website link" maxLength={160} />
                      <select value={instructionLevel} onChange={(event) => setInstructionLevel(event.target.value)}>
                        <option value="optional">Optional</option>
                        <option value="conditional">Only if applicable</option>
                        <option value="required">Required</option>
                      </select>
                      <button type="button" className="small-button" disabled={busy || !instruction.trim()} onClick={addInstruction}>Add</button>
                    </div>
                  </div>
                </section>
              )}
            </section>
          )}
        </div>
      )}
    </main>
  );
}
