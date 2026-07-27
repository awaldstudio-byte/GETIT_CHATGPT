import { useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { clock, elapsed, label, money, remaining } from '../../lib/format.js';

const STATUS_RANK = {
  available: 0,
  busy: 1,
  ready_to_depart: 1,
  out_for_delivery: 1,
  break_requested: 2,
  break: 3,
  unavailable: 4,
  offline: 5,
};

const ACTIVE_STATUSES = new Set(['available', 'busy', 'ready_to_depart', 'out_for_delivery']);
const PAUSED_STATUSES = new Set(['break_requested', 'break']);
const DRIVER_READY_ORDER_STATUSES = new Set(['paid', 'shopping', 'packing', 'ready']);
const isInactiveDriver = (driver) => ['offline', 'unavailable'].includes(driver.effective_status);

function AvailabilityLabel({ status, compact = false }) {
  const available = status === 'available';
  return (
    <span className={`availability-label ${available ? 'available' : ''} status-label-${status} ${compact ? 'compact' : ''}`}>
      <i /> {label(status)}
    </span>
  );
}

function LoadBar({ value = 0 }) {
  const percentage = Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100)));
  return (
    <div className="load-track" title={`${percentage}% full`}>
      <span style={{ width: `${percentage}%` }} />
    </div>
  );
}

function OrderRow({ order, onAssign, onView }) {
  return (
    <article className={`order-row ${order.priority ? 'priority' : ''}`}>
      <div className="order-main customer-first">
        <strong>{order.customer_name || 'Customer'}</strong>
        <small>{order.order_number}{order.priority ? ' · Priority' : ''}</small>
      </div>
      <div className="order-main">
        <span>{order.item_lines || 0} items</span>
        <small>{money(order.order_total)}</small>
      </div>
      <div className="order-meta">
        <div className="order-tag-row">
          <span className={`tag status-${order.payment_status}`}>{label(order.payment_status)}</span>
          {order.location_quality && (
            <span className={`tag location-${order.location_quality}`}>{label(order.location_quality)}</span>
          )}
        </div>
        <small>{order.delivery_area || order.delivery_address || 'Area not set'}</small>
      </div>
      <div className="order-actions">
        <button type="button" className="small-button" onClick={() => onView(order)}>View</button>
        <button type="button" className="small-button" onClick={() => onAssign(order)}>Manual driver</button>
      </div>
    </article>
  );
}

export default function DriverBoard({ data, api, onError, onToast, onNavigate }) {
  const [overrideDriver, setOverrideDriver] = useState(null);
  const [overrideStatus, setOverrideStatus] = useState('break');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideUntil, setOverrideUntil] = useState('');
  const [assignmentOrder, setAssignmentOrder] = useState(null);
  const [viewOrder, setViewOrder] = useState(null);
  const [viewDetail, setViewDetail] = useState(null);
  const [driverOptions, setDriverOptions] = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [busy, setBusy] = useState(false);

  const orderSort = (a, b) => {
    if (Boolean(a.priority) !== Boolean(b.priority)) return a.priority ? -1 : 1;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  };

  const ordersByDriver = useMemo(() => {
    const grouped = new Map();
    for (const order of data.orders) {
      if (!order.assigned_driver_id || ['delivered', 'cancelled'].includes(order.status)) continue;
      if (!grouped.has(order.assigned_driver_id)) grouped.set(order.assigned_driver_id, []);
      grouped.get(order.assigned_driver_id).push(order);
    }
    for (const orders of grouped.values()) orders.sort(orderSort);
    return grouped;
  }, [data.orders]);

  const sortedDrivers = useMemo(
    () => [...data.drivers].sort((a, b) => {
      const rankDifference = (STATUS_RANK[a.effective_status] ?? 9) - (STATUS_RANK[b.effective_status] ?? 9);
      return rankDifference || String(a.driver_name).localeCompare(String(b.driver_name));
    }),
    [data.drivers],
  );

  const activeDrivers = sortedDrivers.filter((driver) => ACTIVE_STATUSES.has(driver.effective_status));
  const pausedDrivers = sortedDrivers.filter((driver) => PAUSED_STATUSES.has(driver.effective_status));
  const unavailableDrivers = sortedDrivers.filter((driver) => isInactiveDriver(driver));

  const unassigned = data.orders
    .filter(
      (order) =>
        !order.assigned_driver_id &&
        DRIVER_READY_ORDER_STATUSES.has(order.status) &&
        order.payment_status === 'paid' &&
        !order.human_help_required &&
        Boolean(order.delivery_zone_id) &&
        order.location_quality === 'confirmed' &&
        order.delivery_latitude != null &&
        order.delivery_longitude != null,
    )
    .sort(orderSort);

  const runAction = async (promise, success) => {
    setBusy(true);
    try {
      await promise;
      onToast(success);
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openOverride = (driver) => {
    setOverrideDriver(driver);
    setOverrideStatus(driver.override_status || 'break');
    setOverrideReason(driver.override_reason || '');
    setOverrideUntil(
      driver.override_until
        ? new Date(new Date(driver.override_until).getTime() - new Date(driver.override_until).getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : '',
    );
  };

  const openAssignment = async (order) => {
    setAssignmentOrder(order);
    setLoadingOptions(true);
    try {
      const options = await api.queries.manualDriverOptions(order.id);
      setDriverOptions(
        [...options].sort((a, b) => {
          if (a.can_assign !== b.can_assign) return a.can_assign ? -1 : 1;
          const rankDifference = (STATUS_RANK[a.effective_status] ?? 9) - (STATUS_RANK[b.effective_status] ?? 9);
          return rankDifference || String(a.driver_name).localeCompare(String(b.driver_name));
        }),
      );
    } catch (error) {
      onError(error);
    } finally {
      setLoadingOptions(false);
    }
  };

  const openOrder = async (order) => {
    setViewOrder(order);
    setViewDetail(null);
    try {
      setViewDetail(await api.queries.orderReview(order.id));
    } catch (error) {
      onError(error);
    }
  };

  const submitOverride = async (event) => {
    event.preventDefault();
    const until = overrideUntil ? new Date(overrideUntil).toISOString() : null;
    const saved = await runAction(
      api.actions.setDriverOverride(
        overrideDriver.driver_id,
        overrideStatus,
        overrideReason || null,
        until,
      ),
      `${overrideDriver.driver_name} updated`,
    );
    if (saved) setOverrideDriver(null);
  };

  const assign = async (driver, force = false) => {
    const saved = await runAction(
      api.actions.assignDriver(assignmentOrder.id, driver.driver_id, force),
      `${assignmentOrder.customer_name || assignmentOrder.order_number} assigned to ${driver.driver_name}`,
    );
    if (saved) setAssignmentOrder(null);
  };

  const renderDriver = (driver, inactive = false) => {
    const orders = ordersByDriver.get(driver.driver_id) || [];
    const noRun = !driver.current_run_id;
    const activeOrders = orders.filter((order) => order.status !== 'cancelled');
    const hasStatus = (status) => activeOrders.some((order) => order.status === status);
    const nextRunAction = driver.run_status === 'active'
      ? {
          label: 'Complete delivery run',
          className: 'small-button',
          action: () => api.actions.completeRun(driver.current_run_id),
          success: `${driver.driver_name}'s run completed`,
        }
      : hasStatus('paid')
        ? {
            label: 'Start shopping',
            className: 'small-button accent',
            action: () => api.actions.advanceRunFulfilment(driver.current_run_id, 'shopping'),
            success: `${driver.driver_name} started shopping`,
          }
        : hasStatus('shopping')
          ? {
              label: 'Start packing',
              className: 'small-button accent',
              action: () => api.actions.advanceRunFulfilment(driver.current_run_id, 'packing'),
              success: `${driver.driver_name} started packing`,
            }
          : hasStatus('packing')
            ? {
                label: 'Mark collected & ready',
                className: 'small-button accent',
                action: () => api.actions.advanceRunFulfilment(driver.current_run_id, 'ready'),
                success: `${driver.driver_name}'s load is collected and ready`,
              }
            : activeOrders.length > 0 && activeOrders.every((order) => order.status === 'ready')
              ? {
                  label: 'Depart now',
                  className: 'small-button accent',
                  action: () => api.actions.departRun(driver.current_run_id),
                  success: `${driver.driver_name} dispatched`,
                }
              : null;
    return (
      <article className={`driver-card ${inactive ? 'driver-card-inactive' : ''}`} key={driver.driver_id}>
        <header className="driver-header">
          <div>
            <h2>{driver.driver_name}</h2>
            <div className="driver-status-line">
              <AvailabilityLabel status={driver.effective_status} compact />
              <span>
                {driver.logged_in
                  ? 'logged in'
                  : driver.last_seen_at
                    ? `last seen ${elapsed(driver.last_seen_at)} ago`
                    : 'logged out'}
              </span>
            </div>
          </div>
          <button type="button" className="small-button availability-control" disabled={busy} onClick={() => openOverride(driver)}>
            Availability
          </button>
        </header>

        {driver.override_reason && (
          <div className="notice-line">
            Override: {driver.override_reason}
            {driver.override_until ? ` · until ${clock(driver.override_until)}` : ''}
          </div>
        )}

        <div className="driver-run-summary">
          {noRun ? (
            <div>
              <strong>{inactive ? 'Not accepting orders' : 'Waiting for first order'}</strong>
              <span>{inactive ? 'Change Availability to bring this driver back.' : 'No empty time slot is created.'}</span>
            </div>
          ) : (
            <>
              <div className="run-times">
                <span>Started {clock(driver.window_started_at)}</span>
                <strong>{remaining(driver.window_expires_at)}</strong>
              </div>
              <LoadBar value={driver.load_ratio} />
              <div className="capacity-grid">
                <span><strong>{driver.order_count}</strong> / {driver.max_orders} orders</span>
                <span><strong>{driver.used_weight_kg}</strong> / {driver.max_weight_kg} kg</span>
                <span><strong>{driver.used_space_units}</strong> / {driver.max_space_units} space</span>
              </div>
            </>
          )}
        </div>

        <div className="driver-orders">
          <div className="section-mini-heading">
            <strong>What {driver.driver_name.split(' ')[0]} has</strong>
            <span>{orders.length} orders</span>
          </div>
          {orders.length ? (
            orders.map((order) => (
              <OrderRow key={order.id} order={order} onAssign={openAssignment} onView={openOrder} />
            ))
          ) : (
            <p className="empty-message">No orders assigned yet.</p>
          )}
        </div>

        {driver.current_run_id && !inactive && (
          <footer className="driver-footer">
            <span>Oldest order waiting {driver.oldest_order_at ? elapsed(driver.oldest_order_at) : '—'}</span>
            {nextRunAction ? (
              <button
                type="button"
                className={nextRunAction.className}
                disabled={busy}
                onClick={() => runAction(nextRunAction.action(), nextRunAction.success)}
              >
                {nextRunAction.label}
              </button>
            ) : (
              <span className="muted">Waiting for a valid next stage</span>
            )}
          </footer>
        )}
      </article>
    );
  };

  return (
    <main className="page-shell">
      <section className="page-heading">
        <div>
          <p className="eyebrow">TODAY’S DELIVERY FLOOR</p>
          <h1>Start with the drivers</h1>
          <p className="muted">A two-hour window begins only when that driver receives the first confirmed order.</p>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={busy || unassigned.length === 0}
          onClick={() => runAction(api.actions.autoPack(), 'Waiting paid orders packed')}
        >
          {busy ? 'Working…' : unassigned.length ? `Auto pack ${unassigned.length} waiting` : 'Nothing ready to pack'}
        </button>
      </section>

      <section className="driver-group-section">
        <header className="driver-group-heading">
          <div><h2>Working now</h2><span>Available and active drivers</span></div>
          <span className="count-badge">{activeDrivers.length}</span>
        </header>
        <div className="driver-grid">
          {activeDrivers.length ? activeDrivers.map((driver) => renderDriver(driver)) : <div className="panel calm-empty-state"><strong>No drivers available</strong><span>Change a driver’s Availability when they are ready.</span></div>}
        </div>
      </section>

      {pausedDrivers.length > 0 && (
        <section className="driver-group-section">
          <header className="driver-group-heading">
            <div><h2>On break</h2><span>Still visible, but not receiving new orders</span></div>
            <span className="count-badge muted-count">{pausedDrivers.length}</span>
          </header>
          <div className="driver-grid">{pausedDrivers.map((driver) => renderDriver(driver))}</div>
        </section>
      )}

      {unavailableDrivers.length > 0 && (
        <details className="inactive-driver-group">
          <summary>Offline or unavailable drivers ({unavailableDrivers.length})</summary>
          <div className="driver-grid">{unavailableDrivers.map((driver) => renderDriver(driver, true))}</div>
        </details>
      )}

      <section className="panel unassigned-panel">
        <header className="panel-header">
          <div>
            <p className="eyebrow">PAID, CONFIRMED & WAITING</p>
            <h2>Ready for a driver</h2>
          </div>
          <span className="count-badge">{unassigned.length}</span>
        </header>
        {unassigned.length ? (
          unassigned.map((order) => <OrderRow key={order.id} order={order} onAssign={openAssignment} onView={openOrder} />)
        ) : (
          <p className="empty-message">Nothing is ready for a driver.</p>
        )}
      </section>

      {viewOrder && (
        <Modal title={`Order details · ${viewOrder.customer_name || viewOrder.order_number}`} wide onClose={() => setViewOrder(null)}>
          {!viewDetail ? (
            <p className="empty-message">Loading every item and price…</p>
          ) : (
            <div className="order-detail-modal">
              <div className="order-detail-summary">
                <div><span>Customer</span><strong>{viewDetail.order.customer_name}</strong></div>
                <div><span>Order total</span><strong>{money(viewDetail.order.order_total)}</strong></div>
                <div><span>Payment</span><strong>{label(viewDetail.order.payment_status)}</strong></div>
                <div><span>Location</span><strong>{label(viewDetail.order.location_quality || 'missing')}</strong></div>
              </div>
              <div className="order-detail-lines">
                {viewDetail.lines.map((line) => (
                  <article key={line.order_item_id}>
                    <div>
                      <strong>{line.item_name}</strong>
                      <span>{line.shop_name} · quantity {line.quantity}</span>
                    </div>
                    <div>
                      <span>{money(line.review_unit_price)} each</span>
                      <strong>{money(line.review_line_total)}</strong>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}

      {overrideDriver && (
        <Modal title={`Availability · ${overrideDriver.driver_name}`} onClose={() => setOverrideDriver(null)}>
          <form className="modal-form" onSubmit={submitOverride}>
            <label>
              Override status
              <select value={overrideStatus} onChange={(event) => setOverrideStatus(event.target.value)}>
                <option value="available">Available</option>
                <option value="break">Approved break</option>
                <option value="unavailable">Unavailable</option>
                <option value="offline">Offline</option>
              </select>
            </label>
            <label>
              Reason
              <input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Approved lunch break" />
            </label>
            <label>
              Until (optional)
              <input type="datetime-local" value={overrideUntil} onChange={(event) => setOverrideUntil(event.target.value)} />
            </label>
            <div className="modal-actions split">
              <button
                type="button"
                className="ghost-button"
                onClick={async () => {
                  const cleared = await runAction(api.actions.clearDriverOverride(overrideDriver.driver_id), `${overrideDriver.driver_name}'s override cleared`);
                  if (cleared) setOverrideDriver(null);
                }}
              >
                Clear override
              </button>
              <button className="primary-button" disabled={busy}>Save availability</button>
            </div>
          </form>
        </Modal>
      )}

      {assignmentOrder && (
        <Modal title={`Choose driver · ${assignmentOrder.customer_name || assignmentOrder.order_number}`} wide onClose={() => setAssignmentOrder(null)}>
          <div className="assignment-list">
            {loadingOptions ? (
              <p className="empty-message">Checking every driver…</p>
            ) : (
              driverOptions.map((driver) => {
                const orderBlocked = /location|payment|human help|order is not/i.test(driver.unavailable_reason || '');
                return (
                  <article className={`assignment-option ${driver.can_assign ? 'available' : ''} ${isInactiveDriver(driver) ? 'inactive' : ''}`} key={driver.driver_id}>
                    <div>
                      <div className="assignment-driver-heading">
                        <h3>{driver.driver_name}</h3>
                        <AvailabilityLabel status={driver.effective_status} compact />
                      </div>
                      <span>{driver.current_order_count}/{driver.maximum_orders} orders</span>
                      <small>{driver.can_assign ? 'Available for this order' : driver.unavailable_reason || 'Unavailable'}</small>
                    </div>
                    <div className="assignment-actions">
                      {driver.can_assign ? (
                        <button type="button" className="primary-button" disabled={busy} onClick={() => assign(driver)}>Assign</button>
                      ) : isInactiveDriver(driver) ? (
                        <span className="assignment-blocked">Change availability first</span>
                      ) : orderBlocked ? (
                        <span className="assignment-blocked">{driver.unavailable_reason || 'Fix the order first'}</span>
                      ) : (
                        <button type="button" className="ghost-button" disabled={busy} onClick={() => assign(driver, true)}>
                          Override & assign
                        </button>
                      )}
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </Modal>
      )}
    </main>
  );
}
