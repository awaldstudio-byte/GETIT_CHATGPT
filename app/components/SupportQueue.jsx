import { useEffect, useMemo, useState } from 'react';
import { callUrl, elapsed, label, money, whatsappUrl } from '../../lib/format.js';

const TYPE_COPY = {
  payment: 'Payment problem',
  location: 'Location problem',
  product: 'Product question',
  delivery: 'Delivery problem',
  customer_request: 'Customer request',
  other: 'Other help',
};

export default function SupportQueue({ data, api, onError, onToast, onNavigate }) {
  const [selectedId, setSelectedId] = useState(data.openQueries[0]?.id || null);
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!selectedId && data.openQueries[0]) setSelectedId(data.openQueries[0].id);
    if (selectedId && !data.openQueries.some((query) => query.id === selectedId)) {
      setSelectedId(data.openQueries[0]?.id || null);
      setResolution('');
    }
  }, [data.openQueries, selectedId]);

  const selected = useMemo(
    () => data.openQueries.find((query) => query.id === selectedId) || null,
    [data.openQueries, selectedId],
  );

  const resolve = async () => {
    if (!selected) return;
    if (!resolution.trim()) {
      onError(new Error('Add a short note explaining what was done.'));
      return;
    }

    const nextQuery = data.openQueries.find((query) => query.id !== selected.id);
    setBusy(true);
    try {
      await api.actions.resolveSupportQuery(selected.id, resolution.trim());
      onToast(nextQuery ? 'Resolved — opening the next request' : 'Resolved — help queue clear');
      setSelectedId(nextQuery?.id || null);
      setResolution('');
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const contactMessage = selected
    ? `Hi ${selected.customer_name || ''}, this is Getit regarding ${selected.order_number || 'your order'}.`
    : '';

  return (
    <main className="page-shell">
      <section className="page-heading">
        <div>
          <p className="eyebrow">HUMAN ATTENTION</p>
          <h1>Needs help</h1>
          <p className="muted">
            These orders pause here until someone fixes the problem. Resolving the last open issue releases the order automatically.
          </p>
        </div>
        <span className="large-count">{data.openQueries.length}</span>
      </section>

      <section className="help-layout">
        <aside className="panel help-list">
          {data.openQueries.length ? (
            data.openQueries.map((query) => (
              <button
                type="button"
                key={query.id}
                className={`help-list-item ${selectedId === query.id ? 'active' : ''} ${query.priority ? 'priority' : ''}`}
                onClick={() => {
                  setSelectedId(query.id);
                  setResolution('');
                }}
              >
                <div>
                  <strong>{query.customer_name || 'Customer'}</strong>
                  <span>{TYPE_COPY[query.issue_type] || label(query.issue_type)}{query.priority ? ' · Priority' : ''}</span>
                </div>
                <small>{elapsed(query.created_at)}</small>
              </button>
            ))
          ) : (
            <p className="empty-message">Nothing needs human help right now.</p>
          )}
        </aside>

        <section className="panel help-detail">
          {!selected ? (
            <div className="help-empty-state">
              <strong>Everything is clear</strong>
              <span>New human-help requests will appear here.</span>
            </div>
          ) : (
            <>
              <header className="help-detail-header">
                <div>
                  <p className="eyebrow">{TYPE_COPY[selected.issue_type] || label(selected.issue_type)}</p>
                  <h2>{selected.customer_name || 'Customer'}</h2>
                  <span>{selected.order_number || 'Order'} · waiting {elapsed(selected.created_at)}</span>
                  <div className="quick-contact-row">
                    {callUrl(selected.customer_phone) && <a className="small-button link-button" href={callUrl(selected.customer_phone)}>Call customer</a>}
                    {whatsappUrl(selected.customer_phone, contactMessage) && (
                      <a className="small-button link-button" href={whatsappUrl(selected.customer_phone, contactMessage)} target="_blank" rel="noreferrer">WhatsApp</a>
                    )}
                  </div>
                </div>
                {selected.priority && <span className="tag priority-tag">Priority</span>}
              </header>

              <div className="help-summary-grid">
                <div><span>Problem</span><strong>{selected.issue_summary}</strong></div>
                <div><span>Order total</span><strong>{money(selected.order_total)}</strong></div>
                <div><span>Payment</span><strong>{label(selected.payment_status || 'unknown')}</strong></div>
                <div><span>Delivery</span><strong>{selected.delivery_area || selected.delivery_address || 'Not set'}</strong></div>
              </div>

              {selected.support_issue && selected.support_issue !== selected.issue_summary && (
                <div className="help-context-box">
                  <span>Order note</span>
                  <strong>{selected.support_issue}</strong>
                </div>
              )}

              <label className="review-note">
                What was done?
                <textarea
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  placeholder="Example: Confirmed the replacement item with the customer and updated the order."
                />
              </label>

              <footer className="help-detail-footer">
                <button className="ghost-button" type="button" onClick={() => onNavigate?.('operations')}>
                  Open drivers & orders
                </button>
                <button className="primary-button" type="button" disabled={busy || !resolution.trim()} onClick={resolve}>
                  {busy ? 'Resolving…' : 'Resolve & open next'}
                </button>
              </footer>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
