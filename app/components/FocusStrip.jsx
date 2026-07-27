export default function FocusStrip({ data, activeTab, onNavigate }) {
  const availableDrivers = data.drivers.filter((driver) => driver.effective_status === 'available').length;
  const paymentWaiting = data.paymentQueue.filter((item) => item.status === 'pending_review' && !item.human_help_required).length;
  const locationsWaiting = data.orderPins.filter((pin) => pin.location_quality !== 'confirmed').length;
  const helpWaiting = data.openQueries.length;

  const items = [
    { tab: 'operations', label: 'Drivers available', count: availableDrivers, tone: availableDrivers ? 'good' : 'quiet' },
    { tab: 'payments', label: 'Waiting to pay', count: paymentWaiting, tone: paymentWaiting ? 'urgent' : 'quiet' },
    { tab: 'map', label: 'Locations to check', count: locationsWaiting, tone: locationsWaiting ? 'attention' : 'quiet' },
    { tab: 'help', label: 'Needs help', count: helpWaiting, tone: helpWaiting ? 'danger' : 'quiet' },
  ];

  return (
    <section className="focus-strip" aria-label="Current operational attention">
      {items.map((item) => (
        <button
          type="button"
          key={item.tab}
          className={`focus-card ${item.tone} ${activeTab === item.tab ? 'active' : ''}`}
          onClick={() => onNavigate(item.tab)}
        >
          <span>{item.label}</span>
          <strong>{item.count}</strong>
        </button>
      ))}
    </section>
  );
}
