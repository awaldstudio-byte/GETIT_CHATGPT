const connectionCopy = (connection, browserOnline, stale) => {
  if (!browserOnline) return { label: 'Offline', tone: 'offline' };
  if (stale) return { label: 'Delayed', tone: 'warning' };
  if (connection === 'SUBSCRIBED') return { label: 'Live', tone: 'live' };
  if (connection === 'CHANNEL_ERROR' || connection === 'TIMED_OUT') return { label: 'Reconnecting', tone: 'warning' };
  return { label: 'Connecting', tone: 'warning' };
};

export default function Topbar({
  connection,
  browserOnline,
  stale,
  lastUpdated,
  paymentCount,
  helpCount,
  locationCount,
  messagingCount,
  launchQueueCount,
  applicationsCount,
  automationCount,
  activeTab,
  setActiveTab,
  refreshing,
  onRefresh,
  onSignOut,
}) {
  const live = connectionCopy(connection, browserOnline, stale);
  const tabs = [
    ['operations', 'Drivers & orders', 0],
    ['payments', 'Payments', paymentCount],
    ['map', 'Map & locations', locationCount],
    ['catalogue', 'Find a price', 0],
    ['messaging', 'Messaging', messagingCount],
    ['launch_queue', 'Launch queue', launchQueueCount],
    ['applications', 'Shop manager', applicationsCount],
    ['automation', 'Automation', automationCount],
    ['help', 'Needs help', helpCount],
  ];

  return (
    <div className="nav-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-logo-shell topbar-logo">
            <img className="brand-logo" src="/getit-mark.png" alt="Getit" />
          </div>
          <div>
            <strong>Getit Control Centre</strong>
            <span>Live operations</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`live-pill ${live.tone}`} title={`Last updated ${lastUpdated || 'not yet'}`}>
            <i /> {live.label}
          </span>
          <span className="last-updated">Updated {lastUpdated || '—'}</span>
          <button type="button" className="ghost-button" onClick={onRefresh} disabled={refreshing || !browserOnline}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="ghost-button" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      <nav className="tabs" aria-label="Control Centre sections">
        {tabs.map(([value, text, count]) => (
          <button
            type="button"
            key={value}
            className={`${activeTab === value ? 'active' : ''} ${count ? 'has-attention' : ''}`}
            onClick={() => setActiveTab(value)}
          >
            <span>{text}</span>
            {count > 0 && <b>{count}</b>}
          </button>
        ))}
      </nav>
    </div>
  );
}
