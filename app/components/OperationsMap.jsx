"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callUrl, label, money, whatsappUrl } from '../../lib/format.js';

const VILLIERS = [-27.0308, 28.6004];
const QALABOTJHA = [-27.0229, 28.6259];
const QUALITY_RANK = { missing: 0, needs_confirmation: 1, gps_received: 2, confirmed: 3 };

const nextStep = (pin) => {
  if (pin.human_help_required) return 'Needs human help';
  if (pin.payment_status !== 'paid') return 'Payment review';
  if (pin.assigned_driver_id) return 'Already assigned';
  return 'Ready for a driver';
};

const icon = (L, kind, selected, quality) =>
  L.divIcon({
    className: 'getit-map-icon-wrap',
    html: `<div class="getit-map-icon ${kind} ${selected ? 'selected' : ''} quality-${quality || 'unknown'}"><span>${
      kind === 'shop' ? 'S' : 'G'
    }</span></div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });

const validPoint = (value) => {
  if (!value || value.latitude === '' || value.longitude === '') return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? [latitude, longitude] : null;
};

function MapCanvas({ orderPins, shopPins, selected, draft, selectedFallbackCenter, onSelect, onDraftMove }) {
  const elementRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const leafletRef = useRef(null);
  const selectedRef = useRef(selected);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    let cancelled = false;

    async function createMap() {
      if (!elementRef.current || mapRef.current) return;
      const module = await import('leaflet');
      if (cancelled || !elementRef.current) return;
      const L = module.default ?? module;
      leafletRef.current = L;
      mapRef.current = L.map(elementRef.current, { zoomControl: true }).setView(VILLIERS, 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 20,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(mapRef.current);
      mapRef.current.on('click', (event) => {
        if (!selectedRef.current) return;
        onDraftMove({ latitude: event.latlng.lat, longitude: event.latlng.lng });
      });
      layerRef.current = L.layerGroup().addTo(mapRef.current);
      setMapReady(true);
      window.setTimeout(() => mapRef.current?.invalidateSize(), 80);
    }

    createMap();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
      leafletRef.current = null;
    };
  }, [onDraftMove]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    const L = leafletRef.current;
    if (!mapReady || !map || !layer || !L) return;
    layer.clearLayers();
    const bounds = [];
    let selectedPoint = null;
    const selectedDraft = validPoint(draft);

    for (const pin of shopPins) {
      const isSelected = selected?.kind === 'shop' && selected.id === pin.shop_id;
      const point = isSelected && selectedDraft
        ? selectedDraft
        : pin.latitude != null && pin.longitude != null
          ? [Number(pin.latitude), Number(pin.longitude)]
          : null;
      if (!point) continue;
      const marker = L.marker(point, {
        icon: icon(L, 'shop', isSelected, pin.coordinates_verified ? 'confirmed' : 'needs_confirmation'),
        draggable: isSelected,
      }).addTo(layer);
      marker.bindTooltip(`${pin.shop_name}${pin.street_address ? ` · ${pin.street_address}` : ''}`);
      marker.on('click', () => onSelect({ kind: 'shop', id: pin.shop_id }));
      marker.on('dragend', (event) => {
        const moved = event.target.getLatLng();
        onDraftMove({ latitude: moved.lat, longitude: moved.lng });
      });
      bounds.push(point);
      if (isSelected) selectedPoint = point;
    }

    for (const pin of orderPins) {
      const isSelected = selected?.kind === 'order' && selected.id === pin.order_id;
      const point = isSelected && selectedDraft
        ? selectedDraft
        : pin.latitude != null && pin.longitude != null
          ? [Number(pin.latitude), Number(pin.longitude)]
          : null;
      if (!point) continue;
      const marker = L.marker(point, {
        icon: icon(L, 'order', isSelected, pin.location_quality),
        draggable: isSelected,
      }).addTo(layer);
      marker.bindTooltip(`${pin.customer_name || pin.order_number} · ${label(pin.location_quality)}`);
      marker.on('click', () => onSelect({ kind: 'order', id: pin.order_id }));
      marker.on('dragend', (event) => {
        const moved = event.target.getLatLng();
        onDraftMove({ latitude: moved.lat, longitude: moved.lng });
      });
      bounds.push(point);
      if (isSelected) selectedPoint = point;
    }

    if (selectedPoint) {
      map.setView(selectedPoint, Math.max(map.getZoom(), 16));
    } else if (selected && selectedFallbackCenter) {
      map.setView(selectedFallbackCenter, 15);
    } else if (bounds.length && !selected) {
      map.fitBounds(bounds, { padding: [35, 35], maxZoom: 16 });
    }
  }, [mapReady, orderPins, shopPins, selected, draft, selectedFallbackCenter, onSelect, onDraftMove]);

  return <div className={`map-canvas ${selected ? 'placing-pin' : ''}`} ref={elementRef} />;
}

function LocationQueueCard({ pin, selected, onClick, confirmed = false }) {
  return (
    <button type="button" className={`location-queue-card ${selected ? 'active' : ''} ${confirmed ? 'confirmed' : ''}`} onClick={onClick}>
      <div className="location-card-heading">
        <div>
          <strong>{pin.customer_name || 'Customer'}</strong>
          <span>{pin.order_number}</span>
        </div>
        <div className="location-card-flags">
          {pin.priority && <span className="tag priority-tag">Priority</span>}
          <span className={`tag location-${pin.location_quality}`}>{label(pin.location_quality)}</span>
        </div>
      </div>
      <div className="location-card-body">
        <span><b>From:</b> {pin.shops_summary || 'Shop not selected yet'}</span>
        <span><b>Order:</b> {pin.items_summary || `${pin.item_lines || 0} items`}</span>
        <span><b>Total:</b> {money(pin.order_total)}</span>
        <span><b>Next:</b> {nextStep(pin)}</span>
        <span><b>Address:</b> {pin.delivery_address || 'Waiting for address or GPS pin'}</span>
      </div>
    </button>
  );
}

export default function OperationsMap({ data, api, onError, onToast, onNavigate }) {
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [address, setAddress] = useState('');
  const [shopAddress, setShopAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpSummary, setHelpSummary] = useState('');

  const attentionPins = useMemo(
    () => data.orderPins
      .filter((pin) => pin.location_quality !== 'confirmed')
      .sort((a, b) => {
        if (Boolean(a.priority) !== Boolean(b.priority)) return a.priority ? -1 : 1;
        const qualityDifference = (QUALITY_RANK[a.location_quality] ?? 9) - (QUALITY_RANK[b.location_quality] ?? 9);
        return qualityDifference || new Date(a.created_at || 0) - new Date(b.created_at || 0);
      }),
    [data.orderPins],
  );

  const confirmedPins = useMemo(
    () => data.orderPins
      .filter((pin) => pin.location_quality === 'confirmed')
      .sort((a, b) => new Date(b.location_confirmed_at || b.location_received_at || 0) - new Date(a.location_confirmed_at || a.location_received_at || 0)),
    [data.orderPins],
  );

  const sortedShops = useMemo(
    () => [...data.shopPins].sort((a, b) => {
      if (a.coordinates_verified !== b.coordinates_verified) return a.coordinates_verified ? -1 : 1;
      return String(a.shop_name).localeCompare(String(b.shop_name));
    }),
    [data.shopPins],
  );

  const selectedPin = useMemo(() => {
    if (!selected) return null;
    return selected.kind === 'order'
      ? data.orderPins.find((pin) => pin.order_id === selected.id)
      : data.shopPins.find((pin) => pin.shop_id === selected.id);
  }, [selected, data.orderPins, data.shopPins]);

  const selectedFallbackCenter = useMemo(() => {
    if (selected?.kind !== 'order' || !selectedPin || validPoint(selectedPin)) return null;
    const locationText = `${selectedPin.delivery_address || ''} ${selectedPin.delivery_area || ''}`.toLowerCase();
    return locationText.includes('qalabotjha') ? QALABOTJHA : VILLIERS;
  }, [selected, selectedPin]);

  const hasDraftPoint = Boolean(validPoint(draft));

  useEffect(() => {
    if (!selectedPin) {
      setDraft(null);
      setAddress('');
      setShopAddress('');
      setHelpOpen(false);
      setHelpSummary('');
      return;
    }
    setDraft({
      latitude: selectedPin.latitude == null ? '' : String(selectedPin.latitude),
      longitude: selectedPin.longitude == null ? '' : String(selectedPin.longitude),
    });
    setAddress(selected?.kind === 'order' ? selectedPin.delivery_address || '' : '');
    setShopAddress(selected?.kind === 'shop' ? selectedPin.street_address || '' : '');
    setHelpOpen(false);
    setHelpSummary('');
  }, [selectedPin, selected]);

  const selectPin = useCallback((value) => setSelected(value), []);
  const moveDraft = useCallback((value) => setDraft(value), []);

  const save = async () => {
    if (!selected || !draft) return;
    if (draft.latitude === '' || draft.longitude === '') {
      onError(new Error('Choose the delivery point on the map first.'));
      return;
    }
    const latitude = Number(draft.latitude);
    const longitude = Number(draft.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      onError(new Error('Choose a valid point on the map or enter a valid latitude.'));
      return;
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      onError(new Error('Choose a valid point on the map or enter a valid longitude.'));
      return;
    }

    const nextOrder = selected.kind === 'order'
      ? attentionPins.find((pin) => pin.order_id !== selected.id)
      : null;

    setBusy(true);
    try {
      if (selected.kind === 'order') {
        await api.actions.saveOrderLocation({
          orderId: selected.id,
          latitude,
          longitude,
          source: 'control_centre',
          typedAddress: address || null,
          confirmed: true,
          note: 'Pin corrected and confirmed in the Control Centre',
        });
        onToast(nextOrder ? 'Location confirmed — opening the next customer' : 'Location confirmed — queue complete');
        setSelected(nextOrder ? { kind: 'order', id: nextOrder.order_id } : null);
      } else {
        await api.actions.saveShopLocation({
          shopId: selected.id,
          latitude,
          longitude,
          streetAddress: shopAddress || null,
          verified: true,
          note: 'Shop entrance confirmed in the Control Centre',
        });
        onToast('Shop address and entrance saved');
      }
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const sendToHelp = async () => {
    if (!selectedPin?.order_id || !helpSummary.trim()) {
      onError(new Error('Add a short description of the location problem.'));
      return;
    }
    setBusy(true);
    try {
      await api.actions.createSupportQuery(selectedPin.order_id, 'location', helpSummary.trim());
      onToast('Location moved to Needs help');
      setHelpOpen(false);
      setHelpSummary('');
      onNavigate?.('help');
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const addressSearchUrl = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : null;
  const contactMessage = selectedPin?.order_id
    ? `Hi ${selectedPin.customer_name || ''}, Getit needs help confirming the delivery location for ${selectedPin.order_number}.`
    : '';

  return (
    <main className="page-shell">
      <section className="page-heading">
        <div>
          <p className="eyebrow">LOCATION CHECKS</p>
          <h1>Confirm where the customer is</h1>
          <p className="muted">Town addresses stay as addresses. Qalabotjha deliveries can rely on the customer’s WhatsApp pin and landmark.</p>
        </div>
        <div className="map-stats">
          <span><strong>{attentionPins.length}</strong> need checking</span>
          <span><strong>{confirmedPins.length}</strong> confirmed</span>
        </div>
      </section>

      <section className="map-layout">
        <div className="panel map-panel">
          {selected && <div className="map-place-hint">Click the map or drag the selected pin to the correct entrance.</div>}
          <MapCanvas
            orderPins={data.orderPins}
            shopPins={data.shopPins}
            selected={selected}
            draft={draft}
            selectedFallbackCenter={selectedFallbackCenter}
            onSelect={selectPin}
            onDraftMove={moveDraft}
          />
        </div>

        <aside className="panel pin-inspector">
          {!selectedPin ? (
            <div className="location-sidebar">
              <section>
                <div className="location-section-heading">
                  <div>
                    <p className="eyebrow">NEXT TO CHECK</p>
                    <h2>Customers</h2>
                  </div>
                  <span className="count-badge">{attentionPins.length}</span>
                </div>
                <div className="location-queue-list">
                  {attentionPins.length ? attentionPins.map((pin) => (
                    <LocationQueueCard
                      key={pin.order_id}
                      pin={pin}
                      onClick={() => setSelected({ kind: 'order', id: pin.order_id })}
                    />
                  )) : <p className="empty-message">Every current location is confirmed.</p>}
                </div>
              </section>

              {confirmedPins.length > 0 && (
                <details className="confirmed-location-list">
                  <summary>Recently confirmed ({confirmedPins.length})</summary>
                  <div className="location-queue-list compact">
                    {confirmedPins.map((pin) => (
                      <LocationQueueCard
                        key={pin.order_id}
                        pin={pin}
                        confirmed
                        onClick={() => setSelected({ kind: 'order', id: pin.order_id })}
                      />
                    ))}
                  </div>
                </details>
              )}

              <details className="shop-location-list">
                <summary>Shop locations ({sortedShops.length})</summary>
                <div className="shop-list">
                  {sortedShops.map((shop) => (
                    <button type="button" key={shop.shop_id} onClick={() => setSelected({ kind: 'shop', id: shop.shop_id })}>
                      <div><strong>{shop.shop_name}</strong><span>{shop.street_address || 'Address still required'}</span></div>
                      <span className={`shop-verification ${shop.coordinates_verified ? 'verified' : ''}`}>
                        {shop.coordinates_verified ? 'Verified' : 'Check'}
                      </span>
                    </button>
                  ))}
                </div>
              </details>
            </div>
          ) : selected.kind === 'order' ? (
            <>
              <button className="inspector-back" type="button" onClick={() => setSelected(null)}>← Back to location queue</button>
              <div className="pin-customer-heading">
                <div>
                  <p className="eyebrow">{selectedPin.order_number}</p>
                  <h2>{selectedPin.customer_name || 'Customer'}</h2>
                </div>
                <div className="location-card-flags">
                  {selectedPin.priority && <span className="tag priority-tag">Priority</span>}
                  <span className={`tag location-${selectedPin.location_quality}`}>{label(selectedPin.location_quality)}</span>
                </div>
              </div>

              <div className="quick-contact-row">
                {callUrl(selectedPin.customer_phone) && <a className="small-button link-button" href={callUrl(selectedPin.customer_phone)}>Call customer</a>}
                {whatsappUrl(selectedPin.customer_phone, contactMessage) && (
                  <a className="small-button link-button" href={whatsappUrl(selectedPin.customer_phone, contactMessage)} target="_blank" rel="noreferrer">WhatsApp</a>
                )}
              </div>

              <div className="pin-order-summary">
                <div><span>Ordering from</span><strong>{selectedPin.shops_summary || 'Not selected yet'}</strong></div>
                <div><span>What they want</span><strong>{selectedPin.items_summary || `${selectedPin.item_lines || 0} items`}</strong></div>
                <div><span>Total order</span><strong>{money(selectedPin.order_total)}</strong></div>
                <div><span>Payment</span><strong>{label(selectedPin.payment_status || 'unknown')}</strong></div>
                <div><span>After confirmation</span><strong>{nextStep(selectedPin)}</strong></div>
              </div>

              {selectedPin.human_help_required && (
                <button type="button" className="map-help-warning button-warning" onClick={() => onNavigate?.('help')}>
                  Needs human help: {selectedPin.support_issue || 'Open the Needs help tab.'}
                </button>
              )}

              <div className="pin-source-line">
                <span>Source: {label(selectedPin.location_source || 'unknown')}</span>
                {selectedPin.location_accuracy_meters != null && (
                  <span>GPS accuracy: ±{selectedPin.location_accuracy_meters} m</span>
                )}
              </div>

              <label>
                Written address or landmark
                <textarea value={address} onChange={(event) => setAddress(event.target.value)} placeholder="House number and street, or a clear landmark in Qalabotjha" />
              </label>

              <details className="advanced-location">
                <summary>Advanced coordinates</summary>
                <div className="coordinate-grid">
                  <label>
                    Latitude
                    <input type="number" step="0.0000001" value={draft?.latitude ?? ''} onChange={(event) => setDraft((current) => ({ ...current, latitude: event.target.value }))} />
                  </label>
                  <label>
                    Longitude
                    <input type="number" step="0.0000001" value={draft?.longitude ?? ''} onChange={(event) => setDraft((current) => ({ ...current, longitude: event.target.value }))} />
                  </label>
                </div>
              </details>

              {!hasDraftPoint && (
                <p className="soft-warning">
                  This customer has no saved GPS pin yet. Click the exact entrance on the map; the other G markers belong to other orders.
                </p>
              )}
              {!address.trim() && <p className="soft-warning">Add a street address or useful landmark so the driver has context alongside the pin.</p>}

              {helpOpen && (
                <div className="inline-help-form">
                  <label>
                    What is wrong with this location?
                    <input value={helpSummary} onChange={(event) => setHelpSummary(event.target.value)} placeholder="Example: Customer pin and written address do not match" />
                  </label>
                  <div className="inline-help-actions">
                    <button type="button" className="ghost-button" onClick={() => setHelpOpen(false)}>Cancel</button>
                    <button type="button" className="small-button accent" disabled={busy} onClick={sendToHelp}>Move to Needs help</button>
                  </div>
                </div>
              )}

              <div className="pin-actions">
                {selectedPin.google_maps_url && (
                  <a className="ghost-button link-button" href={selectedPin.google_maps_url} target="_blank" rel="noreferrer">Open current pin</a>
                )}
                {!selectedPin.google_maps_url && addressSearchUrl && (
                  <a className="ghost-button link-button" href={addressSearchUrl} target="_blank" rel="noreferrer">Open written address in Google Maps</a>
                )}
                <button className="primary-button" type="button" disabled={busy} onClick={save}>
                  {busy
                    ? 'Saving…'
                    : !hasDraftPoint
                      ? 'Click the map to place this customer’s pin'
                      : selectedPin.location_quality === 'confirmed'
                        ? 'Save correction'
                        : 'Confirm & open next customer'}
                </button>
                {!helpOpen && <button className="text-button" type="button" onClick={() => setHelpOpen(true)}>This location needs human help</button>}
                {selectedPin.location_quality === 'confirmed' && (
                  <button className="ghost-button" type="button" onClick={() => onNavigate?.('operations')}>Open drivers & orders</button>
                )}
              </div>
            </>
          ) : (
            <>
              <button className="inspector-back" type="button" onClick={() => setSelected(null)}>← Back to location queue</button>
              <p className="eyebrow">SHOP ENTRANCE</p>
              <h2>{selectedPin.shop_name}</h2>
              <span className={`tag ${selectedPin.coordinates_verified ? 'location-confirmed' : 'location-needs_confirmation'}`}>
                {selectedPin.coordinates_verified ? 'Verified shop entrance' : 'Needs verification'}
              </span>

              <label>
                Actual street address
                <textarea value={shopAddress} onChange={(event) => setShopAddress(event.target.value)} placeholder="Street number, street name, Villiers, 9840" />
              </label>

              <details className="advanced-location">
                <summary>Advanced coordinates</summary>
                <div className="coordinate-grid">
                  <label>
                    Latitude
                    <input type="number" step="0.0000001" value={draft?.latitude ?? ''} onChange={(event) => setDraft((current) => ({ ...current, latitude: event.target.value }))} />
                  </label>
                  <label>
                    Longitude
                    <input type="number" step="0.0000001" value={draft?.longitude ?? ''} onChange={(event) => setDraft((current) => ({ ...current, longitude: event.target.value }))} />
                  </label>
                </div>
              </details>

              <p className="muted small-text">The marker should sit on the customer entrance, not in the road or centre of the property.</p>

              <div className="pin-actions">
                {selectedPin.google_maps_url && (
                  <a className="ghost-button link-button" href={selectedPin.google_maps_url} target="_blank" rel="noreferrer">Open in Google Maps</a>
                )}
                <button className="primary-button" disabled={busy || !validPoint(draft)} onClick={save}>{busy ? 'Saving…' : 'Save verified shop'}</button>
              </div>
            </>
          )}
        </aside>
      </section>
    </main>
  );
}
