"use client";

import { useEffect, useRef, useState } from "react";

const DEFAULT_CENTER = [-27.0333, 28.6];

function validCoordinate(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

export default function DispatchMap({
  orders = [],
  pickups = [],
  selectedStopKey = null,
  onSelectStop,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const leafletRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function createMap() {
      if (!containerRef.current || mapRef.current) return;
      const module = await import("leaflet");
      if (cancelled) return;
      const L = module.default ?? module;
      leafletRef.current = L;

      const map = L.map(containerRef.current, {
        zoomControl: true,
        attributionControl: true,
      }).setView(DEFAULT_CENTER, 13);

      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      setMapReady(true);
      setTimeout(() => map.invalidateSize(), 80);
    }

    createMap();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      layerRef.current = null;
      leafletRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !layerRef.current || !leafletRef.current) return;

    const L = leafletRef.current;
    const layer = layerRef.current;
    layer.clearLayers();

    const mappedPickups = pickups
      .filter((pickup) => validCoordinate(pickup.shop?.latitude) && validCoordinate(pickup.shop?.longitude))
      .sort((a, b) => (a.pickup_sequence ?? 999) - (b.pickup_sequence ?? 999));

    const mappedOrders = orders
      .filter((order) => validCoordinate(order.delivery_latitude) && validCoordinate(order.delivery_longitude))
      .sort((a, b) => (a.stop_sequence ?? 999) - (b.stop_sequence ?? 999));

    if (!mappedPickups.length && !mappedOrders.length) {
      mapRef.current.setView(DEFAULT_CENTER, 13);
      return;
    }

    const points = [];

    mappedPickups.forEach((pickup, index) => {
      const lat = Number(pickup.shop.latitude);
      const lng = Number(pickup.shop.longitude);
      const sequence = pickup.pickup_sequence ?? index + 1;
      const stopKey = `pickup-${pickup.id}`;
      const isSelected = selectedStopKey === stopKey;
      const icon = L.divIcon({
        className: "getit-map-icon-shell",
        html: `<div class="getit-map-pickup${isSelected ? " selected" : ""}"><span>P${sequence}</span></div>`,
        iconSize: [38, 38],
        iconAnchor: [19, 19],
        popupAnchor: [0, -18],
      });

      const marker = L.marker([lat, lng], { icon }).addTo(layer);
      marker.bindPopup(`
        <div class="getit-map-popup">
          <strong>Pickup ${sequence} · ${pickup.shop?.name || "Shop"}</strong>
          <span>${pickup.item_line_count ?? 0} item lines for this run</span>
          <small>Status: ${pickup.status || "pending"}</small>
        </div>
      `);
      marker.on("click", () => onSelectStop?.(stopKey));
      points.push([lat, lng]);
    });

    mappedOrders.forEach((order, index) => {
      const lat = Number(order.delivery_latitude);
      const lng = Number(order.delivery_longitude);
      const stopNumber = order.stop_sequence ?? index + 1;
      const stopKey = `order-${order.id}`;
      const isSelected = selectedStopKey === stopKey;
      const icon = L.divIcon({
        className: "getit-map-icon-shell",
        html: `<div class="getit-map-pin${isSelected ? " selected" : ""}"><span>${stopNumber}</span></div>`,
        iconSize: [36, 42],
        iconAnchor: [18, 40],
        popupAnchor: [0, -34],
      });

      const marker = L.marker([lat, lng], { icon }).addTo(layer);
      marker.bindPopup(`
        <div class="getit-map-popup">
          <strong>Drop-off ${stopNumber} · ${order.order_number}</strong>
          <span>${order.customer?.full_name || "Unknown customer"}</span>
          <small>${order.delivery_address || "No address recorded"}</small>
        </div>
      `);
      marker.on("click", () => onSelectStop?.(stopKey));
      points.push([lat, lng]);
    });

    if (points.length > 1) {
      L.polyline(points, {
        color: "#168bff",
        weight: 4,
        opacity: 0.72,
        dashArray: "7 9",
      }).addTo(layer);
    }

    const bounds = L.latLngBounds(points);
    mapRef.current.fitBounds(bounds.pad(0.18), { maxZoom: 16 });
  }, [mapReady, onSelectStop, orders, pickups, selectedStopKey]);

  return <div ref={containerRef} className="dispatch-map" aria-label="Pickup and delivery stop map" />;
}
