"use client";

import { useMemo, useState } from "react";

const QUICK_PROMPTS = [
  "What needs attention right now?",
  "Summarise today's backlog and the safest order to handle it.",
  "Check messaging and applications for risks or stuck work.",
  "What should staff handle first, and why?",
];

const statusLabel = (status) => ({
  queued: "Queued",
  processing: "Checking",
  completed: "Ready",
  failed: "Could not complete",
  cancelled: "Cancelled",
}[status] || status);

const when = (value) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-ZA", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
};

export default function OperationsSupervisor({ data, api, onError, onToast }) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const requests = useMemo(() => data.supervisorRequests || [], [data.supervisorRequests]);

  const ask = async (event) => {
    event?.preventDefault();
    const question = prompt.trim();
    if (!question || submitting || !api) return;
    setSubmitting(true);
    try {
      await api.actions.createSupervisorRequest(question);
      setPrompt("");
      onToast("Supervisor check queued — it will appear here when ready");
    } catch (error) {
      onError(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="supervisor-page">
      <section className="supervisor-hero">
        <div>
          <span className="eyebrow">Operations intelligence</span>
          <h1>Getit supervisor</h1>
          <p>Ask what is happening across the Control Centre and get a prioritised, evidence-based operating brief.</p>
        </div>
        <span className="supervisor-mode">Read-only advisor</span>
      </section>

      <section className="supervisor-safety">
        <strong>Safe by design</strong>
        <span>This supervisor can inspect a sanitised operations snapshot and recommend next steps. It cannot message customers, approve payments, activate partners, alter records or expose private technical details. Every proposed action still needs staff confirmation.</span>
      </section>

      <section className="panel supervisor-ask">
        <header>
          <div>
            <span className="eyebrow">Ask the control room</span>
            <h2>What do you need help with?</h2>
          </div>
        </header>
        <div className="supervisor-quick-prompts">
          {QUICK_PROMPTS.map((question) => (
            <button type="button" key={question} onClick={() => setPrompt(question)}>{question}</button>
          ))}
        </div>
        <form onSubmit={ask}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={2000}
            placeholder="For example: check the backlog and tell me what requires attention first…"
            aria-label="Question for the operations supervisor"
          />
          <div>
            <small>{prompt.length}/2000</small>
            <button type="submit" className="primary-button" disabled={!prompt.trim() || submitting || !api}>
              {submitting ? "Queuing…" : "Ask supervisor"}
            </button>
          </div>
        </form>
      </section>

      <section className="supervisor-results">
        <header>
          <div>
            <span className="eyebrow">Recent briefs</span>
            <h2>Supervisor responses</h2>
          </div>
          <small>{requests.length} recent request{requests.length === 1 ? "" : "s"}</small>
        </header>

        {!requests.length ? (
          <div className="calm-empty-state">
            <strong>No supervisor checks yet</strong>
            <span>Ask a question above. The supervisor will only use current, sanitised Control Centre facts.</span>
          </div>
        ) : requests.map((request) => {
          const response = request.response || {};
          const findings = Array.isArray(response.findings) ? response.findings : [];
          const actions = Array.isArray(response.recommended_actions) ? response.recommended_actions : [];
          const limitations = Array.isArray(response.limitations) ? response.limitations : [];
          return (
            <article className={`supervisor-brief ${request.status}`} key={request.id}>
              <header>
                <div>
                  <span className="eyebrow">{when(request.created_at)}</span>
                  <h3>{request.prompt}</h3>
                </div>
                <span className={`tag supervisor-status ${request.status}`}>{statusLabel(request.status)}</span>
              </header>

              {["queued", "processing"].includes(request.status) && (
                <p className="supervisor-progress">The supervisor is checking current operating facts. No action is being taken.</p>
              )}
              {request.status === "failed" && (
                <p className="supervisor-error">{request.error_message || "The check failed safely. Nothing was changed."}</p>
              )}
              {request.status === "completed" && (
                <div className="supervisor-brief-body">
                  <div className={`supervisor-summary ${response.severity || "info"}`}>
                    <span>{response.severity || "info"}</span>
                    <p>{response.summary || "The supervisor returned no summary."}</p>
                  </div>
                  {findings.length > 0 && (
                    <div className="supervisor-section">
                      <h4>What it found</h4>
                      <ul>{findings.map((finding, index) => <li key={`${request.id}-finding-${index}`}>{typeof finding === "string" ? finding : `${finding.title ? `${finding.title}: ` : ""}${finding.detail || finding.summary || "No detail supplied."}`}</li>)}</ul>
                    </div>
                  )}
                  {actions.length > 0 && (
                    <div className="supervisor-section">
                      <h4>Recommended next steps</h4>
                      <div className="supervisor-actions">
                        {actions.map((action, index) => (
                          <div key={`${request.id}-action-${index}`}>
                            <span>{index + 1}</span>
                            <p>{typeof action === "string" ? action : `${action.label || action.action || "Recommended action"}${action.reason ? ` — ${action.reason}` : ""}`}</p>
                            <small>Staff confirmation required</small>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {limitations.length > 0 && (
                    <div className="supervisor-limitations">
                      <strong>Limits of this check</strong>
                      <span>{limitations.join(" · ")}</span>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </section>
    </main>
  );
}
