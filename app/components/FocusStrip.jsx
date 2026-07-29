export default function FocusStrip({ data, activeTab, onNavigate }) {
  const availableDrivers = data.drivers.filter((driver) => driver.effective_status === 'available').length;
  const paymentWaiting = data.paymentQueue.filter((item) => item.status === 'pending_review' && !item.human_help_required).length;
  const locationsWaiting = data.orderPins.filter((pin) => pin.location_quality !== 'confirmed').length;
  const helpWaiting = data.openQueries.length;
  const automationBacklog = Number(data.health?.automation_backlog || 0);

  const items = [
    { id: 'drivers', tab: 'operations', label: 'Drivers available', count: availableDrivers, tone: availableDrivers ? 'good' : 'quiet' },
    { id: 'payments', tab: 'payments', label: 'Waiting to pay', count: paymentWaiting, tone: paymentWaiting ? 'urgent' : 'quiet' },
    { id: 'locations', tab: 'map', label: 'Locations to check', count: locationsWaiting, tone: locationsWaiting ? 'attention' : 'quiet' },
    { id: 'help', tab: 'help', label: 'Needs help', count: helpWaiting, tone: helpWaiting ? 'danger' : 'quiet' },
    { id: 'automation', tab: 'operations', label: 'Automation backlog', count: automationBacklog, tone: automationBacklog ? 'danger' : 'good' },
  ];

  return (
    <section className="focus-strip" aria-label="Current operational attention">
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
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
