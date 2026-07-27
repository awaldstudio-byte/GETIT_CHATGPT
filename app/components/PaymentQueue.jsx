import { useEffect, useMemo, useState } from 'react';
import { callUrl, elapsed, label, money, whatsappUrl } from '../../lib/format.js';

const ISSUE_TYPES = [
  ['payment', 'Payment problem'],
  ['product', 'Product question'],
  ['location', 'Location problem'],
  ['customer_request', 'Customer request'],
  ['other', 'Other'],
];

export default function PaymentQueue({ data, api, onError, onToast, onNavigate }) {
  const [selectedId, setSelectedId] = useState(data.paymentQueue[0]?.order_id || null);
  const [detail, setDetail] = useState(null);
  const [prices, setPrices] = useState({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [issueType, setIssueType] = useState('product');
  const [issueSummary, setIssueSummary] = useState('');

  useEffect(() => {
    if (!selectedId && data.paymentQueue[0]) setSelectedId(data.paymentQueue[0].order_id);
    if (selectedId && !data.paymentQueue.some((item) => item.order_id === selectedId)) {
      setSelectedId(data.paymentQueue[0]?.order_id || null);
      setDetail(null);
    }
  }, [data.paymentQueue, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetail(null);
    api.queries
      .orderReview(selectedId)
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setPrices(
          Object.fromEntries(
            result.lines.map((line) => [line.order_item_id, String(line.review_unit_price ?? '')]),
          ),
        );
        setNote(result.review?.review_note || '');
        setHelpOpen(false);
        setIssueSummary('');
      })
      .catch(onError);
    return () => {
      active = false;
    };
  }, [selectedId, api, onError]);

  const reviewedTotal = useMemo(
    () =>
      detail?.lines.reduce(
        (sum, line) => sum + Number(prices[line.order_item_id] || 0) * Number(line.quantity || 0),
        0,
      ) || 0,
    [detail, prices],
  );

  const selectedQueue = data.paymentQueue.find((item) => item.order_id === selectedId);
  const pausedForHelp = Boolean(selectedQueue?.human_help_required || detail?.order?.human_help_required);
  const allPricesValid = Boolean(detail?.lines.length) && detail.lines.every((line) => {
    const raw = prices[line.order_item_id];
    const price = Number(raw);
    return raw !== '' && Number.isFinite(price) && price >= 0;
  });

  const saveLine = async (line) => {
    const price = Number(prices[line.order_item_id]);
    if (!Number.isFinite(price) || price < 0) return onError(new Error('Enter a valid price.'));
    setBusy(true);
    try {
      await api.actions.updateItemPrice(line.order_item_id, price, line.review_note || null);
      onToast(`${line.item_name} price checked`);
      const refreshed = await api.queries.orderReview(selectedId);
      setDetail(refreshed);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const saveAllAndApprove = async () => {
    if (!detail?.lines.length) return;
    setBusy(true);
    try {
      const reviewedItems = detail.lines.map((line) => {
        const price = Number(prices[line.order_item_id]);
        if (prices[line.order_item_id] === '' || !Number.isFinite(price) || price < 0) {
          throw new Error(`Check the price for ${line.item_name}.`);
        }
        return {
          order_item_id: line.order_item_id,
          unit_price: price,
          note: line.review_note || null,
        };
      });

      const nextRequest = data.paymentQueue.find(
        (item) =>
          item.order_id !== selectedId
          && item.status === 'pending_review'
          && !item.human_help_required,
      );
      await api.actions.approvePaymentWithPrices(selectedId, reviewedItems, note || null);
      onToast(nextRequest ? 'Approved — opening the next customer' : 'Approved — payment link request sent');
      setSelectedId(nextRequest?.order_id || null);
      setDetail(null);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const sendToHelp = async () => {
    if (!selectedId || !issueSummary.trim()) {
      onError(new Error('Add a short description of what needs help.'));
      return;
    }
    setBusy(true);
    try {
      await api.actions.createSupportQuery(selectedId, issueType, issueSummary.trim());
      onToast('Order moved to Needs help');
      setHelpOpen(false);
      setIssueSummary('');
      onNavigate?.('help');
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const customerPhone = detail?.order?.customer_phone;
  const customerMessage = detail?.order
    ? `Hi ${detail.order.customer_name || ''}, Getit is checking your order ${detail.order.order_number}.`
    : '';

  return (
    <main className="page-shell">
      <section className="page-heading">
        <div>
          <p className="eyebrow">CUSTOMER WAITING</p>
          <h1>Payment review queue</h1>
          <p className="muted">Check the items and prices first. Approval then queues the secure payment link automatically.</p>
        </div>
        <span className="large-count">{data.paymentQueue.filter((item) => item.status === 'pending_review' && !item.human_help_required).length}</span>
      </section>

      <section className="payment-layout">
        <aside className="payment-list panel">
          {data.paymentQueue.length ? (
            data.paymentQueue.map((item) => (
              <button
                type="button"
                key={item.order_id}
                className={`payment-list-item ${selectedId === item.order_id ? 'active' : ''} ${item.priority ? 'priority' : ''} ${item.human_help_required ? 'paused-help' : ''}`}
                onClick={() => setSelectedId(item.order_id)}
              >
                <div>
                  <strong>{item.customer_name || 'Customer'}</strong>
                  <span>{item.order_number}{item.priority ? ' · Priority' : ''}{item.human_help_required ? ' · Paused for help' : ''}</span>
                </div>
                <div>
                  <span className={`tag status-${item.status}`}>{label(item.status)}</span>
                  <small>waiting {elapsed(item.requested_at)}</small>
                </div>
              </button>
            ))
          ) : (
            <p className="empty-message">No customers are waiting for a payment link.</p>
          )}
        </aside>

        <section className="payment-review panel">
          {!selectedId ? (
            <div className="calm-empty-state">
              <strong>Payment queue clear</strong>
              <span>New requests will appear here automatically.</span>
            </div>
          ) : !detail ? (
            <p className="empty-message">Loading the full order…</p>
          ) : (
            <>
              <header className="review-header">
                <div>
                  <p className="eyebrow">{detail.order.order_number}</p>
                  <h2>{detail.order.customer_name}</h2>
                  <p>{detail.order.delivery_address || 'No delivery address yet'}</p>
                  <div className="quick-contact-row">
                    {callUrl(customerPhone) && <a className="small-button link-button" href={callUrl(customerPhone)}>Call customer</a>}
                    {whatsappUrl(customerPhone, customerMessage) && (
                      <a className="small-button link-button" href={whatsappUrl(customerPhone, customerMessage)} target="_blank" rel="noreferrer">WhatsApp</a>
                    )}
                    <span className={`tag location-${detail.order.location_quality || 'missing'}`}>{label(detail.order.location_quality || 'location missing')}</span>
                  </div>
                </div>
                <div className="review-total">
                  <span>Reviewed goods</span>
                  <strong>{money(reviewedTotal)}</strong>
                </div>
              </header>

              {pausedForHelp && (
                <div className="payment-help-pause">
                  <div>
                    <strong>Paused in Needs help</strong>
                    <span>{selectedQueue?.support_issue || detail.order.support_issue || 'Resolve the open help request before approving payment.'}</span>
                  </div>
                  <button type="button" className="small-button" onClick={() => onNavigate?.('help')}>Open Needs help</button>
                </div>
              )}

              <div className="review-lines">
                {detail.lines.map((line) => {
                  const currentPrice = Number(prices[line.order_item_id] || 0);
                  const storedPrice = Number(line.review_unit_price || 0);
                  const dirty = currentPrice !== storedPrice || !line.price_verified;
                  return (
                    <article className={`review-line ${dirty ? 'needs-check' : 'checked'}`} key={line.order_item_id}>
                      <div className="review-product">
                        <strong>{line.item_name}</strong>
                        <span>{line.shop_name} · qty {line.quantity}</span>
                      </div>
                      <label className="price-input">
                        Unit price
                        <span>
                          R
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            inputMode="decimal"
                            value={prices[line.order_item_id] ?? ''}
                            onChange={(event) =>
                              setPrices((current) => ({
                                ...current,
                                [line.order_item_id]: event.target.value,
                              }))
                            }
                          />
                        </span>
                      </label>
                      <div className="line-total">
                        <span>Line total</span>
                        <strong>{money(currentPrice * line.quantity)}</strong>
                      </div>
                      <button type="button" className="small-button" disabled={busy || !dirty} onClick={() => saveLine(line)}>
                        {dirty ? 'Check price' : 'Checked ✓'}
                      </button>
                    </article>
                  );
                })}
              </div>

              <div className="fee-summary">
                <div><span>Goods</span><strong>{money(reviewedTotal)}</strong></div>
                <div><span>Delivery</span><strong>{money(selectedQueue?.delivery_fee)}</strong></div>
                <div><span>Second shop</span><strong>{money(selectedQueue?.second_shop_fee)}</strong></div>
                <div><span>Priority</span><strong>{money(selectedQueue?.priority_fee)}</strong></div>
                <div className="grand-total">
                  <span>Amount customer will pay</span>
                  <strong>{money(reviewedTotal + Number(selectedQueue?.delivery_fee || 0) + Number(selectedQueue?.second_shop_fee || 0) + Number(selectedQueue?.priority_fee || 0))}</strong>
                </div>
              </div>

              <label className="review-note">
                Review note (optional)
                <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Prices checked against the current shelf list." />
              </label>

              {helpOpen && (
                <div className="inline-help-form">
                  <div className="inline-help-grid">
                    <label>
                      Type of help
                      <select value={issueType} onChange={(event) => setIssueType(event.target.value)}>
                        {ISSUE_TYPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                      </select>
                    </label>
                    <label>
                      What is wrong?
                      <input value={issueSummary} onChange={(event) => setIssueSummary(event.target.value)} placeholder="Example: Customer must approve a replacement item" />
                    </label>
                  </div>
                  <div className="inline-help-actions">
                    <button type="button" className="ghost-button" onClick={() => setHelpOpen(false)}>Cancel</button>
                    <button type="button" className="small-button accent" disabled={busy} onClick={sendToHelp}>Move to Needs help</button>
                  </div>
                </div>
              )}

              <footer className="review-footer">
                <div>
                  <p>The customer remains in the chat while the bot says the payment link is being prepared.</p>
                  {!helpOpen && <button type="button" className="text-button" onClick={() => setHelpOpen(true)}>Something needs human help</button>}
                </div>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || pausedForHelp || selectedQueue?.status !== 'pending_review' || !allPricesValid}
                  onClick={saveAllAndApprove}
                >
                  {busy
                    ? 'Approving…'
                    : pausedForHelp
                      ? 'Resolve Needs help first'
                      : selectedQueue?.status === 'pending_review'
                      ? 'Approve & open next'
                      : selectedQueue?.status === 'link_ready'
                        ? 'Payment link ready'
                        : 'Payment link requested'}
                </button>
              </footer>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
