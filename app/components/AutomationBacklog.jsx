import { dateTime, label } from '../../lib/format';

const toneFor = (status) => {
  if (status === 'pending') return 'attention';
  if (status === 'processing') return 'urgent';
  if (status === 'failed') return 'danger';
  return 'quiet';
};

export default function AutomationBacklog({ data, onRefresh }) {
  const events = data.automationEvents || [];

  return (
    <main className="page-shell">
      <section className="page-heading">
        <div>
          <p className="eyebrow">REAL AUTOMATION EVENTS</p>
          <h1>Automation backlog</h1>
          <p className="muted">
            Each row is one lifecycle update. Several rows can belong to the same order.
          </p>
        </div>
        <button type="button" className="ghost-button" onClick={onRefresh}>Refresh queue</button>
      </section>

      <section className="panel automation-panel">
        <header className="panel-header">
          <div>
            <p className="eyebrow">WAITING OR STUCK</p>
            <h2>{events.length ? `${events.length} updates need attention` : 'Queue clear'}</h2>
          </div>
          <span className="count-badge">{events.length}</span>
        </header>

        {events.length ? (
          <div className="automation-event-list">
            {events.map((event) => (
              <article className="automation-event-row" key={event.id}>
                <div>
                  <strong>{label(event.event_type)}</strong>
                  <span>
                    {event.orders?.order_number || 'No order linked'} · created {dateTime(event.created_at)}
                  </span>
                </div>
                <div className="automation-event-meta">
                  <span className={`tag ${toneFor(event.status)}`}>{label(event.status)}</span>
                  <small>{Number(event.attempts || 0)} attempts</small>
                </div>
                {event.error_message && <p>{event.error_message}</p>}
              </article>
            ))}
          </div>
        ) : (
          <div className="calm-empty-state">
            <strong>No automation updates are waiting</strong>
            <span>Future backlogs will appear here instead of being mixed up with the order board.</span>
          </div>
        )}
      </section>
    </main>
  );
}
