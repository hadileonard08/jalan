'use client';

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapPoint, RouteWaypoint } from '../../agents/transport';

interface DailyRouteMapProps {
  waypoints: RouteWaypoint[];
  polyline?: MapPoint[];
  className?: string;
}

function numberMarkerIcon(order: number) {
  return L.divIcon({
    html: `<div style="
      width: 26px;
      height: 26px;
      border-radius: 9999px;
      background: #2563eb;
      color: #fff;
      font: 700 13px/26px system-ui, sans-serif;
      text-align: center;
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
      border: 2px solid #fff;
    ">${order}</div>`,
    className: '',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

export default function DailyRouteMap({ waypoints, polyline, className = '' }: DailyRouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || waypoints.length === 0) return;

    // Defensive: clear any stale Leaflet state from strict-mode remounts.
    (container as any)._leaflet_id = undefined;
    (container as any).leaflet = undefined;

    const map = L.map(container).setView([waypoints[0].lat, waypoints[0].lon], 14);
    mapRef.current = map;

    L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        subdomains: 'abc',
        maxZoom: 19,
      }
    ).addTo(map);

    const bounds = L.latLngBounds([]);

    waypoints.forEach((wp) => {
      const marker = L.marker([wp.lat, wp.lon], {
        icon: numberMarkerIcon(wp.order),
        title: wp.name,
      }).addTo(map);
      marker.bindPopup(wp.name);
      bounds.extend([wp.lat, wp.lon]);
    });

    if (polyline && polyline.length > 0) {
      L.polyline(
        polyline.map((p) => [p.lat, p.lon]),
        { color: '#2563eb', weight: 4, opacity: 0.8 }
      ).addTo(map);
      polyline.forEach((p) => bounds.extend([p.lat, p.lon]));
    }

    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    }

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [waypoints, polyline]);

  if (waypoints.length === 0) {
    return (
      <div className={`bg-gray-100 rounded-2xl flex items-center justify-center text-gray-500 text-sm ${className}`}>
        No route coordinates available.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`w-full h-72 rounded-2xl overflow-hidden border border-black/[0.08] dark:border-white/[0.1] z-0 ${className}`}
    />
  );
}
