// Fleet Shield — JEGASEC
// Connects to the backend over WebSocket for live positions/alerts,
// and REST for geofences + reports.

// CSRF: the server issues a non-httpOnly `fs.csrf` cookie alongside the
// session cookie on successful login. State-changing requests (anything
// but GET/HEAD/OPTIONS) must echo its value back as an X-CSRF-Token header
// — the server rejects the request if the header doesn't match the cookie.
// A page a victim didn't intend to visit can't read this cookie (it's
// scoped to this origin) and so can't forge the header, which is what
// actually blocks cross-site request forgery here (the SameSite=Lax
// session cookie alone already blocks most of this, but this is
// defense-in-depth expected by most security reviews).
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)fs\.csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Session-aware fetch wrapper — if the session has expired server-side,
// every API call starts 401ing; bounce back to the login page instead of
// silently failing. Also attaches the CSRF header on mutating requests.
async function authedFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = getCsrfToken();
    options = {
      ...options,
      headers: { ...(options.headers || {}), ...(token ? { 'X-CSRF-Token': token } : {}) },
    };
  }
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('unauthenticated');
  }
  return res;
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await authedFetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Numberplate is the on-screen identifier for a vehicle everywhere in the
// app. Vehicles added before plates were recorded fall back to their label
// until a plate is set on the Fleet & Billing tab.
function plateOf(v) {
  return v && v.plate ? v.plate : null;
}
function plateBadge(v, extraClass = '') {
  const plate = plateOf(v);
  return plate
    ? `<span class="plate ${extraClass}">${escapeHtml(plate)}</span>`
    : `<span class="plate plate--missing ${extraClass}" title="No numberplate recorded">NO PLATE</span>`;
}

const STATUS_LABEL = { moving: 'Travelling', idling: 'Idling', parked: 'Parked' };
const DATA_STATE_LABEL = { ok: 'GPS OK', signal_lost: 'GPS signal lost', power_lost: 'Device offline' };

const state = {
  vehicles: new Map(),
  markers: new Map(),
  statusFilter: 'all',
  search: '',
  selectedId: null,
  alerts: [],
  geofences: [],
  geofenceLayers: new Map(),
  alertFilter: 'all',
};

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'reports') window.loadReports();
    if (btn.dataset.tab === 'compliance') loadCompliance();
    if (btn.dataset.tab === 'fleet') loadFleetTab();
    if (btn.dataset.tab === 'import') loadImportHistory();
    if (btn.dataset.tab === 'assurance') loadAssurance();
    document.body.classList.toggle('map-mode', btn.dataset.tab === 'map');
    if (btn.dataset.tab === 'map') setTimeout(() => map.invalidateSize(), 50);
  });
});

// ---------------------------------------------------------------------------
// Data Import (secure CSV telemetry import -- internal validation)
// ---------------------------------------------------------------------------
// Parses the compact "[metrics: key=value key=value ...]" suffix that
// server.js appends to each telemetry_csv_import audit-log entry (see
// docs/procurement-evidence/security-control-evidence-index.md). Values are
// numeric or "?" when unavailable; unknown/missing keys render as "-".
function parseImportMetrics(detail) {
  const match = /\[metrics:\s*([^\]]+)\]/.exec(detail || '');
  const metrics = {};
  if (!match) return metrics;
  for (const pair of match[1].trim().split(/\s+/)) {
    const [key, value] = pair.split('=');
    if (key) metrics[key] = value;
  }
  return metrics;
}

async function loadImportHistory() {
  const tbody = document.getElementById('importHistoryRows');
  try {
    const res = await authedFetch('/api/audit?limit=200');
    if (!res.ok) throw new Error('failed to load audit log');
    const rows = await res.json();
    const imports = rows.filter((r) => r.event_type === 'telemetry_csv_import');
    tbody.innerHTML = '';
    if (imports.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" class="hint">No CSV imports have been run for this organisation yet.</td></tr>';
      return;
    }
    for (const row of imports) {
      const m = parseImportMetrics(row.detail);
      const tr = document.createElement('tr');
      const completeness = m.completeness !== undefined ? `${m.completeness}%` : '-';
      const duration = m.durationMs !== undefined && m.durationMs !== '?' ? `${m.durationMs} ms` : '-';
      tr.innerHTML = `
        <td>${new Date(row.ts).toLocaleString()}</td>
        <td>${row.success ? 'Accepted' : 'Rejected'}</td>
        <td>${m.submitted ?? '-'}</td>
        <td>${m.accepted ?? '-'}</td>
        <td>${m.rejected ?? '-'}</td>
        <td>${m.duplicates ?? '-'}</td>
        <td>${m.unknownVehicles ?? '-'}</td>
        <td>${m.invalidCoords ?? '-'}</td>
        <td>${m.invalidTimestamps ?? '-'}</td>
        <td>${completeness}</td>
        <td>${duration}</td>
        <td>${row.username || '-'}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="12" class="hint error">Could not load import history.</td></tr>';
  }
}

document.getElementById('csvImportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById('csvImportResult');
  const fileInput = document.getElementById('csvFile');
  const textInput = document.getElementById('csvText');
  resultEl.textContent = 'Importing...';
  resultEl.classList.remove('error');

  try {
    let csvText;
    if (fileInput.files && fileInput.files[0]) {
      csvText = await fileInput.files[0].text();
    } else {
      csvText = textInput.value;
    }
    if (!csvText || !csvText.trim()) {
      resultEl.textContent = 'Choose a CSV file or paste CSV text before importing.';
      resultEl.classList.add('error');
      return;
    }

    const res = await authedFetch('/api/telemetry/import/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: csvText,
    });
    const data = await res.json();

    if (res.ok && data.accepted) {
      const s = data.summary || {};
      resultEl.textContent = `Imported ${s.validRows ?? '?'}/${s.totalRows ?? '?'} row(s) across ${s.vehiclesImported ?? '?'} vehicle(s). ${data.invalidRows ? data.invalidRows.length : 0} row(s) rejected.`;
      resultEl.classList.remove('error');
      fileInput.value = '';
      textInput.value = '';
    } else {
      const reason = (data.fileErrors && data.fileErrors.join('; ')) || data.error || 'Import was rejected.';
      resultEl.textContent = reason;
      resultEl.classList.add('error');
    }
    loadImportHistory();
  } catch (err) {
    resultEl.textContent = 'Import failed unexpectedly. No rows were written.';
    resultEl.classList.add('error');
  }
});

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------
document.body.classList.add('map-mode');
// Zoom + attribution sit bottom-left: the right side is taken by the
// floating fleet panel, which would otherwise cover the OSM attribution.
// Geofences use the Canvas renderer: with SVG, a depot circle at street
// zoom becomes a path thousands of pixels across, and repainting it beside
// the animated vehicle markers left corrupted slabs over the fleet panel
// and header. Canvas is clipped to the viewport, so its cost stays fixed.
const map = L.map('map', { zoomControl: false, attributionControl: false, minZoom: 3, worldCopyJump: true, renderer: L.canvas({ padding: 0.25 }) }).setView([-37.8136, 144.9631], 10);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
L.control.attribution({ position: 'bottomleft' }).addTo(map);

// Plate tags get crowded when zoomed out to state level; hide them there.
const PLATE_TAG_MIN_ZOOM = 9;
function syncPlateTagVisibility() {
  mapElForZoom.classList.toggle('hide-plate-tags', map.getZoom() < PLATE_TAG_MIN_ZOOM);
}
const mapElForZoom = document.getElementById('map');
map.on('zoomend', syncPlateTagVisibility);
syncPlateTagVisibility();

// Base map. CARTO's raster tiles stopped serving without an API key on
// 25 Sep 2026 (they return an "API KEY REQUIRED" placeholder), which left
// the map blank. If CARTO_BASEMAP_KEY is set on the server we use CARTO
// Dark Matter with it; otherwise standard OpenStreetMap tiles, darkened
// with a CSS filter (.tiles-dark in style.css) to suit the theme.
// referrerPolicy: the app sends no Referer by default (helmet), but OSM's
// tile servers require one, so tiles opt back in to sending the origin.
function addBaseLayer(cartoKey) {
  // Zooming out swaps in a whole new grid of tiles at once. On a large
  // screen that is 60+ simultaneous requests, which OSM's public tile
  // server throttles; the dropped tiles used to stay black for good.
  // Loading only once a zoom/pan settles (rather than at every animation
  // frame) roughly halves the request bursts, and failed tiles are
  // retried with backoff below.
  const common = {
    maxZoom: 19,
    referrerPolicy: 'strict-origin-when-cross-origin',
    updateWhenZooming: false,
    updateWhenIdle: true,
    keepBuffer: 3,
  };
  let layer;
  if (cartoKey) {
    layer = L.tileLayer(
      `https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(cartoKey)}`,
      { ...common, className: 'tiles-stealth', attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }
    );
  } else {
    layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      ...common,
      className: 'tiles-dark',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
  }
  layer.on('tileerror', ({ tile }) => {
    if (tile.getAttribute('src')) retryTile(tile);
  });
  layer.addTo(map);
}

// Retry a failed tile up to 4 times (1.5s, 3s, 6s, 12s). The retry loads
// into a detached Image first and only hands the URL back to the tile once
// it has succeeded, so a failing retry can't re-fire Leaflet's tileerror
// and stack up timers. Same URL, no cache-busting (OSM tile policy).
const TILE_RETRY_MAX = 4;
function retryTile(tile) {
  const attempt = (tile._fsRetries || 0) + 1;
  if (attempt > TILE_RETRY_MAX || !tile.src) return;
  tile._fsRetries = attempt;
  const url = tile.src;
  setTimeout(() => {
    if (!tile.isConnected || tile.src !== url) return; // tile scrolled away / reused
    const probe = new window.Image();
    probe.referrerPolicy = 'strict-origin-when-cross-origin';
    probe.onload = () => {
      if (!tile.isConnected) return;
      tile.src = ''; // force the <img> to reload the (now cached) URL
      tile.src = url;
    };
    probe.onerror = () => retryTile(tile);
    probe.src = url;
  }, 1500 * 2 ** (attempt - 1));
}
fetch('/api/me')
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}))
  .then((me) => addBaseLayer(me && me.mapTileKey));

// Leaflet sizes its tile grid from the #map container's dimensions at the
// moment it's told to recalculate. On phones the container can be the
// wrong size right at page load (webfonts still loading, flex layout not
// yet settled) and since the map tab is active by default, the tab-switch
// invalidateSize() call above never fires to correct it — the map is just
// blank. A ResizeObserver on the container itself fixes this for every
// case that matters: it fires once immediately with the size at the time
// observation starts (covers the initial-load mis-size), and again on any
// later layout change (orientation flips, resizes, font reflow), without
// having to guess which browser event is responsible.
const mapEl = document.getElementById('map');
let mapResizeTimer;
new ResizeObserver(() => {
  clearTimeout(mapResizeTimer);
  mapResizeTimer = setTimeout(() => map.invalidateSize(), 100);
}).observe(mapEl);

// ---------------------------------------------------------------------------
// Vehicle markers — one icon per status, numberplate tag underneath.
//   travelling: green disc with a direction arrow rotated to heading
//   idling:     amber disc, pause glyph, pulsing ring (engine on, stationary)
//   parked:     blue rounded square with a "P" (ignition off)
// ---------------------------------------------------------------------------
const STATUS_GLYPH = {
  moving: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="vm-arrow" d="M12 4.5l5.5 13-5.5-3.2-5.5 3.2z"/></svg>',
  idling: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="7" width="2.8" height="10" rx="1"/><rect x="13.2" y="7" width="2.8" height="10" rx="1"/></svg>',
  parked: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6h4.2a3.8 3.8 0 010 7.6H11.4V18zm2.4-6.6h1.7a1.6 1.6 0 000-3.2h-1.7z"/></svg>',
};

function normStatus(status) {
  return STATUS_GLYPH[status] ? status : 'moving';
}

// The app's CSP (style-src 'self') silently drops inline style=""
// attributes in HTML strings, so markers are built as elements and any
// per-marker styles (heading rotation, group ring) are set through the
// CSSOM, which CSP allows.
function htmlToElement(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function vehicleIcon(v) {
  const status = normStatus(v.status);
  const selected = state.selectedId === v.id ? ' is-selected' : '';
  const degraded = v.dataState && v.dataState !== 'ok' ? ' vm--degraded' : '';
  const plate = plateOf(v);
  const tag = plate
    ? `<span class="vm-plate">${escapeHtml(plate)}</span>`
    : `<span class="vm-plate vm-plate--missing">${escapeHtml(v.label)}</span>`;
  const node = htmlToElement(`<div class="vm vm--${status}${selected}${degraded}">
        <div class="vm-pin"><div class="vm-glyph">${STATUS_GLYPH[status]}</div></div>
        ${tag}
      </div>`);
  node.querySelector('.vm-glyph').style.transform = `rotate(${status === 'moving' ? v.headingDeg || 0 : 0}deg)`;
  return L.divIcon({
    className: 'vm-wrap',
    html: node,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
  });
}

function popupHtml(v) {
  const status = normStatus(v.status);
  return `<div class="vp">
    <div class="vp-head">${plateBadge(v, 'plate--lg')}<span class="status-pill status-${status}">${STATUS_LABEL[status]}</span></div>
    <div class="vp-label">${escapeHtml(v.label)}</div>
    <dl class="vp-grid">
      <dt>Driver</dt><dd>${escapeHtml(v.driver || '—')}</dd>
      <dt>Speed</dt><dd>${v.speedKmh} km/h <span class="vp-muted">(limit ${v.speedLimit})</span></dd>
      <dt>Odometer</dt><dd>${v.odometerKm} km</dd>
      <dt>Fuel</dt><dd>${escapeHtml((v.fuelType || '').toUpperCase())} · ${v.co2Kg} kg CO₂</dd>
      <dt>Utilisation</dt><dd>${v.utilisationPct}%</dd>
      <dt>Safety</dt><dd>${v.safetyScore}</dd>
      <dt>Data trust</dt><dd>${v.trustScore ?? '—'} <span class="vp-muted">· ${DATA_STATE_LABEL[v.dataState] || 'GPS OK'}</span></dd>
    </dl>
  </div>`;
}

function markerVisible(v) {
  return state.statusFilter === 'all' || normStatus(v.status) === state.statusFilter;
}

function upsertMarker(v) {
  let marker = state.markers.get(v.id);
  const status = normStatus(v.status);
  const iconKey = `${status}|${v.plate || ''}|${v.label}|${state.selectedId === v.id}|${v.dataState || 'ok'}`;
  if (!marker) {
    marker = L.marker([v.lat, v.lng], {
      icon: vehicleIcon(v),
      title: plateOf(v) || v.label,
      keyboard: true,
      riseOnHover: true,
    });
    marker.bindPopup(popupHtml(v), { className: 'vp-popup', minWidth: 220 });
    marker.on('click', () => selectVehicle(v.id, { pan: false }));
    marker._fsIconKey = iconKey;
    state.markers.set(v.id, marker);
  } else {
    marker.setLatLng([v.lat, v.lng]);
    if (marker._fsIconKey !== iconKey) {
      marker.setIcon(vehicleIcon(v));
      marker._fsIconKey = iconKey;
    } else if (status === 'moving') {
      // Same icon, new heading: rotate the existing glyph rather than
      // rebuilding the marker DOM every tick.
      const glyph = marker.getElement()?.querySelector('.vm-glyph');
      if (glyph) glyph.style.transform = `rotate(${v.headingDeg || 0}deg)`;
    }
    marker.setPopupContent(popupHtml(v));
  }
  marker.setZIndexOffset(state.selectedId === v.id ? 1000 : status === 'moving' ? 100 : 0);
  const visible = markerVisible(v) && !clusters.memberOf.has(v.id);
  if (visible && !map.hasLayer(marker)) marker.addTo(map);
  if (!visible && map.hasLayer(marker)) map.removeLayer(marker);
}

function refreshAllMarkers() {
  recluster();
  for (const v of state.vehicles.values()) upsertMarker(v);
}

// ---------------------------------------------------------------------------
// Grouping — when zoomed out, vehicles whose icons would overlap on screen
// are drawn as one group marker showing the count, with a ring split by
// status (travelling / idling / parked). Clicking it zooms in to separate
// them; if they share a spot (e.g. parked at the same depot), it lists them.
// The selected vehicle is never grouped, so its popup stays put.
// ---------------------------------------------------------------------------
const CLUSTER_RADIUS_PX = 46; // ≈ icon + plate tag footprint
const CLUSTER_RADIUS_CLOSE_PX = 20; // from zoom 14 up: only near-identical spots
const CLUSTER_CLOSE_ZOOM = 14;
const clusters = { memberOf: new Map(), markers: new Map() }; // vehicleId -> key, key -> marker

function recluster() {
  const zoom = map.getZoom();
  const radius = zoom >= CLUSTER_CLOSE_ZOOM ? CLUSTER_RADIUS_CLOSE_PX : CLUSTER_RADIUS_PX;
  const candidates = Array.from(state.vehicles.values())
    .filter((v) => markerVisible(v) && v.id !== state.selectedId)
    .sort((a, b) => a.id.localeCompare(b.id));

  // Greedy grouping in projected pixel space at the current zoom (pan
  // doesn't change it, so this only needs re-running on zoom/position).
  const groups = [];
  for (const v of candidates) {
    const p = map.project([v.lat, v.lng], zoom);
    let g = groups.find((gr) => gr.center.distanceTo(p) <= radius);
    if (!g) {
      g = { center: p, sum: L.point(0, 0), members: [] };
      groups.push(g);
    }
    g.members.push(v);
    g.sum = g.sum.add(p);
    g.center = g.sum.divideBy(g.members.length);
  }

  clusters.memberOf.clear();
  const live = new Set();
  for (const g of groups) {
    if (g.members.length < 2) continue;
    const key = g.members.map((v) => v.id).join('|');
    live.add(key);
    for (const v of g.members) clusters.memberOf.set(v.id, key);
    const latlng = map.unproject(g.center, zoom);
    const counts = { moving: 0, idling: 0, parked: 0 };
    for (const v of g.members) counts[normStatus(v.status)] += 1;
    const sig = `${counts.moving}/${counts.idling}/${counts.parked}`;
    let m = clusters.markers.get(key);
    if (!m) {
      m = L.marker(latlng, { keyboard: true, zIndexOffset: 500 });
      m.on('click', () => openCluster(key));
      clusters.markers.set(key, m);
    } else {
      m.setLatLng(latlng);
    }
    if (m._fsSig !== sig) {
      m.setIcon(clusterIcon(g.members.length, counts));
      m._fsSig = sig;
    }
    m._fsMembers = g.members.map((v) => v.id);
    m.options.title = `${g.members.length} vehicles`;
    if (!map.hasLayer(m)) m.addTo(map);
  }
  for (const [key, m] of clusters.markers) {
    if (!live.has(key)) {
      map.removeLayer(m);
      clusters.markers.delete(key);
    }
  }
}

function clusterIcon(n, counts) {
  // Ring segments proportional to each status, drawn with a conic gradient.
  const total = counts.moving + counts.idling + counts.parked;
  const a = (counts.moving / total) * 360;
  const b = a + (counts.idling / total) * 360;
  const ring = `conic-gradient(var(--sl-green) 0 ${a}deg, var(--sl-sand) ${a}deg ${b}deg, var(--sl-green-dim) ${b}deg 360deg)`;
  const size = n >= 50 ? 48 : n >= 10 ? 42 : 36;
  return L.divIcon({
    className: 'vm-wrap',
    html: (() => {
      const node = htmlToElement(`<div class="vc"><span class="vc-count">${n}</span></div>`);
      node.style.setProperty('--vc-ring', ring);
      node.style.width = `${size}px`;
      node.style.height = `${size}px`;
      return node;
    })(),
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function openCluster(key) {
  const m = clusters.markers.get(key);
  if (!m) return;
  const members = m._fsMembers.map((id) => state.vehicles.get(id)).filter(Boolean);
  const bounds = L.latLngBounds(members.map((v) => [v.lat, v.lng]));
  const sameSpot = map.project(bounds.getNorthEast(), map.getMaxZoom()).distanceTo(map.project(bounds.getSouthWest(), map.getMaxZoom())) < 30;
  if (!sameSpot && map.getZoom() < map.getMaxZoom()) {
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: Math.max(map.getZoom() + 2, CLUSTER_CLOSE_ZOOM + 1), paddingBottomRight: fleetPanelOffset() });
    return;
  }
  // Vehicles at (almost) the same spot — zooming won't separate them, so
  // list them and let the user pick one.
  const items = members
    .sort((a, b) => (plateOf(a) || a.label).localeCompare(plateOf(b) || b.label))
    .map((v) => `<li><button type="button" class="vc-pick" data-id="${escapeHtml(v.id)}">${plateBadge(v)}<span>${escapeHtml(STATUS_LABEL[normStatus(v.status)])}</span></button></li>`)
    .join('');
  L.popup({ className: 'vp-popup', minWidth: 200 })
    .setLatLng(m.getLatLng())
    .setContent(`<div class="vp"><div class="vp-label">${members.length} vehicles here</div><ul class="vc-list">${items}</ul></div>`)
    .openOn(map);
}

document.getElementById('map').addEventListener('click', (e) => {
  const btn = e.target.closest('.vc-pick');
  if (btn) selectVehicle(btn.dataset.id, { pan: false });
});

map.on('zoomend', refreshAllMarkers);

function selectVehicle(id, { pan = true } = {}) {
  state.selectedId = id;
  refreshAllMarkers();
  renderVehicleList();
  const v = state.vehicles.get(id);
  const marker = state.markers.get(id);
  if (!v || !marker) return;
  if (pan) map.setView([v.lat, v.lng], Math.max(map.getZoom(), 14));
  if (map.hasLayer(marker)) marker.openPopup();
}

// Deferred: popupclose also fires synchronously while a marker is being
// removed from the map (e.g. by the status filter), and re-rendering
// markers in the middle of that removal can leave the marker behind.
map.on('popupclose', () => {
  setTimeout(() => {
    const marker = state.selectedId && state.markers.get(state.selectedId);
    if (state.selectedId && !(marker && marker.isPopupOpen())) {
      state.selectedId = null;
      refreshAllMarkers();
      renderVehicleList();
    }
  }, 0);
});

function fitFleet() {
  const pts = Array.from(state.vehicles.values()).filter(markerVisible).map((v) => [v.lat, v.lng]);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [40, 70], paddingBottomRight: fleetPanelOffset() });
}
// Keep fitted vehicles out from under the floating fleet panel: it sits on
// the right on desktop and as a bottom sheet on narrow screens.
function fleetPanelOffset() {
  const panel = document.getElementById('vehicleList');
  if (!panel) return [40, 40];
  if (window.innerWidth <= 900) return [40, panel.offsetHeight + 50];
  return [panel.classList.contains('collapsed') ? 40 : panel.offsetWidth + 50, 40];
}
document.getElementById('fitFleet').addEventListener('click', fitFleet);

document.querySelectorAll('#statusFilter .st-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    state.statusFilter = chip.dataset.status;
    const sel = state.selectedId && state.vehicles.get(state.selectedId);
    if (sel && !markerVisible(sel)) {
      state.selectedId = null;
      map.closePopup();
    }
    document.querySelectorAll('#statusFilter .st-chip').forEach((c) => {
      const on = c === chip;
      c.classList.toggle('active', on);
      c.setAttribute('aria-pressed', String(on));
    });
    refreshAllMarkers();
    renderVehicleList();
    fitFleet();
  });
});

document.getElementById('plateSearch').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderVehicleList();
});

document.getElementById('fleetToggle').addEventListener('click', (e) => {
  const panel = document.getElementById('vehicleList');
  const collapsed = panel.classList.toggle('collapsed');
  e.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  e.currentTarget.textContent = collapsed ? 'Show' : 'Hide';
});

function renderGeofences() {
  for (const layer of state.geofenceLayers.values()) map.removeLayer(layer);
  state.geofenceLayers.clear();
  for (const gf of state.geofences) {
    // Stealth palette: depots in dim phosphor, restricted zones in brand
    // red, custom zones in tactical sand; dashed outlines, faint fill.
    const color = gf.type === 'restricted' ? '#ff4d5e' : gf.type === 'depot' ? '#0f9a3a' : '#c8b46a';
    const circle = L.circle([gf.lat, gf.lng], {
      radius: gf.radiusM,
      color,
      fillColor: color,
      fillOpacity: 0.06,
      weight: 1.2,
      dashArray: '4 4',
    }).addTo(map);
    circle.bindTooltip(gf.name, { permanent: false });
    state.geofenceLayers.set(gf.id, circle);
  }
}

// ---------------------------------------------------------------------------
// Vehicle sidebar
// ---------------------------------------------------------------------------
const STATUS_ORDER = { moving: 0, idling: 1, parked: 2 };

function renderStatusCounts() {
  const counts = { moving: 0, idling: 0, parked: 0 };
  for (const v of state.vehicles.values()) counts[normStatus(v.status)] += 1;
  document.getElementById('cntAll').textContent = state.vehicles.size;
  document.getElementById('cntMoving').textContent = counts.moving;
  document.getElementById('cntIdling').textContent = counts.idling;
  document.getElementById('cntParked').textContent = counts.parked;
}

function renderVehicleList() {
  const container = document.getElementById('vehicleItems');
  renderStatusCounts();
  const q = state.search;
  const list = Array.from(state.vehicles.values())
    .filter(markerVisible)
    .filter((v) => !q || `${v.plate || ''} ${(v.plate || '').replace(/[ -]/g, '')} ${v.label} ${v.driver || ''}`.toLowerCase().includes(q))
    .sort((a, b) =>
      (STATUS_ORDER[normStatus(a.status)] - STATUS_ORDER[normStatus(b.status)]) ||
      (!plateOf(a) - !plateOf(b)) ||
      (plateOf(a) || a.label).localeCompare(plateOf(b) || b.label)
    );
  document.getElementById('fleetCount').textContent =
    list.length === state.vehicles.size ? state.vehicles.size : `${list.length} / ${state.vehicles.size}`;

  container.innerHTML = list.length
    ? ''
    : '<p class="hint fleet-empty">No vehicles match.</p>';
  for (const v of list) {
    const status = normStatus(v.status);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `vehicle-item vi--${status}${state.selectedId === v.id ? ' is-selected' : ''}`;
    const detail =
      v.dataState && v.dataState !== 'ok'
        ? `<span class="vi-warn">${DATA_STATE_LABEL[v.dataState]}</span>`
        : status === 'moving' ? `${v.speedKmh} km/h` : status === 'idling' ? 'Engine on' : 'Ignition off';
    el.innerHTML = `
      <span class="vi-icon vm--${status}" aria-hidden="true"><span class="vm-pin"><span class="vm-glyph">${STATUS_GLYPH[status]}</span></span></span>
      <span class="vi-main">
        <span class="vi-row1">${plateBadge(v)}<span class="vi-status">${v.dataState && v.dataState !== 'ok' ? detail : `${STATUS_LABEL[status]} · ${detail}`}</span></span>
        <span class="vi-row2">${escapeHtml(v.label)}${v.driver ? ` · ${escapeHtml(v.driver)}` : ''}</span>
      </span>`;
    el.querySelector('.vm-glyph').style.transform = `rotate(${status === 'moving' ? v.headingDeg || 0 : 0}deg)`;
    el.addEventListener('click', () => selectVehicle(v.id));
    container.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
function alertVehicleCell(a) {
  const v = a.vehicleId ? state.vehicles.get(a.vehicleId) : null;
  if (v && v.plate) return `${plateBadge(v)} <span class="vp-muted">${escapeHtml(v.label)}</span>`;
  return escapeHtml(a.vehicleLabel || '—');
}

function renderAlerts() {
  const rows = document.getElementById('alertRows');
  const filtered =
    state.alertFilter === 'all'
      ? state.alerts
      : state.alerts.filter((a) => a.severity === state.alertFilter);
  rows.innerHTML = filtered
    .slice(0, 200)
    .map(
      (a) => `
      <tr>
        <td>${new Date(a.t).toLocaleTimeString()}</td>
        <td>${alertVehicleCell(a)}</td>
        <td>${a.type.replace(/_/g, ' ')}</td>
        <td><span class="sev sev-${a.severity}">${a.severity}</span></td>
        <td>${a.message}</td>
      </tr>`
    )
    .join('');
  document.getElementById('alertCount').textContent = state.alerts.length;
}

document.getElementById('alertFilter').addEventListener('change', (e) => {
  state.alertFilter = e.target.value;
  renderAlerts();
});

// ---------------------------------------------------------------------------
// Reports — see reports.js (window.loadReports).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Assurance
// ---------------------------------------------------------------------------
function trustClass(score) {
  return score >= 85 ? 'good' : score >= 60 ? 'medium' : 'high';
}

async function loadAssurance() {
  const rowsEl = document.getElementById('asRows');
  let data;
  try {
    const res = await authedFetch('/api/assurance');
    if (!res.ok) throw new Error('failed');
    data = await res.json();
  } catch (err) {
    rowsEl.innerHTML = '<tr><td colspan="7" class="hint error">Could not load assurance data.</td></tr>';
    return;
  }
  const { settings, labels, fleetCounts, vehicles, recent } = data;
  document.getElementById('asSimNote').hidden = !settings.simulatedFaults;
  const fill = { maxPlausibleKmh: settings.maxPlausibleKmh, signalLossSec: settings.signalLossSec, hours: `${settings.operatingHours.start}:00–${settings.operatingHours.end}:00`, tz: settings.timeZone };
  document.querySelectorAll('#asMethod [data-as]').forEach((el) => { el.textContent = fill[el.dataset.as]; });

  const avg = vehicles.length ? Math.round(vehicles.reduce((s, v) => s + v.trustScore, 0) / vehicles.length) : 100;
  const card = (value, label, extra = '') => `<div class="card ${extra}"><div class="value">${value}</div><div class="label">${escapeHtml(label)}</div></div>`;
  document.getElementById('asCards').innerHTML =
    card(avg, 'Fleet data trust (avg)', `as-trust as-trust--${trustClass(avg)}`) +
    ['gps_jump', 'gps_signal_loss', 'device_tamper', 'odometer_mismatch', 'after_hours_movement']
      .map((t) => card(fleetCounts[t] || 0, `${labels[t]} · 24 h`))
      .join('');

  const sorted = vehicles.slice().sort((a, b) => a.trustScore - b.trustScore || (a.plate || a.label).localeCompare(b.plate || b.label));
  rowsEl.innerHTML = sorted
    .map((v) => {
      const counts = Object.entries(v.counts)
        .map(([t, n]) => `<span class="as-chip" title="${escapeHtml(labels[t] || t)}">${escapeHtml((labels[t] || t).replace(/ \(.*\)/, ''))} ×${n}</span>`)
        .join(' ') || '<span class="hint">None</span>';
      return `<tr>
        <td>${plateBadge(v)}</td>
        <td>${escapeHtml(v.label)}</td>
        <td><span class="sev sev-${trustClass(v.trustScore)}">${v.trustScore}</span></td>
        <td>${escapeHtml(DATA_STATE_LABEL[v.dataState] || 'GPS OK')}</td>
        <td>${counts}</td>
        <td>${v.lastEventAt ? new Date(v.lastEventAt).toLocaleString() : '—'}</td>
        <td><a class="as-link" href="/api/vehicles/${encodeURIComponent(v.id)}/evidence.csv?hours=24" download>Last 24 h (CSV)</a></td>
      </tr>`;
    })
    .join('');

  document.getElementById('asRecent').innerHTML = recent.length
    ? recent
        .map((a) => {
          const v = state.vehicles.get(a.vehicleId);
          return `<tr>
            <td>${new Date(a.t).toLocaleString()}</td>
            <td>${v ? plateBadge(v) : '—'}</td>
            <td>${escapeHtml(labels[a.type] || a.type)}</td>
            <td><span class="sev sev-${escapeHtml(a.severity)}">${escapeHtml(a.severity)}</span></td>
            <td>${escapeHtml(a.message || '')}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="hint">No assurance events yet.</td></tr>';
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------
async function loadCompliance() {
  const res = await authedFetch('/api/compliance');
  const rows = await res.json();
  document.getElementById('complianceRows').innerHTML = rows
    .map(
      (v) => `
      <tr>
        <td>${plateBadge(v)}</td>
        <td>${escapeHtml(v.label)}</td>
        <td>${escapeHtml(v.driver || '—')}</td>
        <td>${v.safetyScore}</td>
        <td>${v.regoExpiryDate} (${v.regoDaysRemaining}d)</td>
        <td><span class="sev sev-${complianceSev(v.regoStatus)}">${v.regoStatus.replace('_', ' ')}</span></td>
        <td>${v.kmToNextService} km</td>
        <td><span class="sev sev-${complianceSev(v.serviceStatus)}">${v.serviceStatus.replace('_', ' ')}</span></td>
      </tr>`
    )
    .join('');
}

function complianceSev(status) {
  if (status === 'overdue') return 'high';
  if (status === 'due_soon') return 'medium';
  return 'good';
}

// ---------------------------------------------------------------------------
// Fleet & Billing tab
// ---------------------------------------------------------------------------
// Subscription is $17.50 AUD/vehicle/month, quantity synced automatically
// to whatever's shown here — adding/removing a vehicle updates the Stripe
// subscription's billed quantity server-side (see POST/DELETE
// /api/vehicles in server.js). No payment details are handled by this
// page; card collection only ever happens on Stripe's own signup Checkout.
async function loadFleetTab() {
  const [meRes, vehiclesRes] = await Promise.all([
    authedFetch('/api/me'),
    authedFetch('/api/vehicles'),
  ]);
  const me = await meRes.json();
  const vehicles = await vehiclesRes.json();

  const monthlyTotal = (vehicles.length * me.pricePerVehicleAud).toFixed(2);
  document.getElementById('billingCards').innerHTML = `
    <div class="card"><div class="value">${vehicles.length}</div><div class="label">Vehicles billed</div></div>
    <div class="card"><div class="value">$${me.pricePerVehicleAud.toFixed(2)}</div><div class="label">Per vehicle / month (AUD)</div></div>
    <div class="card"><div class="value">$${monthlyTotal}</div><div class="label">Estimated monthly total (AUD)</div></div>
    <div class="card"><div class="value value--sm">${me.subscriptionStatus}</div><div class="label">Subscription status</div></div>
  `;

  const list = document.getElementById('fleetVehicleList');
  list.innerHTML = vehicles
    .map(
      (v) => `
    <div class="geofence-card fleet-card">
      <div>
        <div class="fleet-card-title">${plateBadge(v)} ${escapeHtml(v.label)} <span class="gf-type custom">${escapeHtml(v.fuelType.toUpperCase())}</span></div>
        <div class="meta">${escapeHtml(v.driver || 'No driver assigned')} · ${escapeHtml(v.id)}</div>
        <form class="plate-edit" data-id="${escapeHtml(v.id)}" hidden>
          <input type="text" class="plate-input" maxlength="12" required placeholder="e.g. 1AB 2CD" value="${escapeHtml(v.plate || '')}" aria-label="Numberplate for ${escapeHtml(v.label)}" />
          <button type="submit" class="btn-plate-save">Save</button>
          <span class="hint error plate-err"></span>
        </form>
      </div>
      <div class="fleet-card-actions">
        <button type="button" class="btn-plate" data-edit="${escapeHtml(v.id)}">${v.plate ? 'Edit plate' : 'Set plate'}</button>
        <button type="button" data-id="${escapeHtml(v.id)}">Remove</button>
      </div>
    </div>`
    )
    .join('') || '<p class="hint">No vehicles yet — add your first one.</p>';

  list.querySelectorAll('button[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const form = list.querySelector(`form.plate-edit[data-id="${CSS.escape(btn.dataset.edit)}"]`);
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('input').focus();
    });
  });
  list.querySelectorAll('form.plate-edit').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.plate-err');
      err.textContent = '';
      const res = await authedFetch(`/api/vehicles/${encodeURIComponent(form.dataset.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plate: form.querySelector('input').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        err.textContent = data.error || 'Could not save numberplate.';
        return;
      }
      const live = state.vehicles.get(data.id);
      if (live) {
        live.plate = data.plate;
        refreshAllMarkers();
        renderVehicleList();
      }
      loadFleetTab();
    });
  });

  list.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this vehicle? This also lowers your monthly bill by $17.50.')) return;
      await authedFetch(`/api/vehicles/${btn.dataset.id}`, { method: 'DELETE' });
      loadFleetTab();
    });
  });
}

// Submitting "Add Vehicle" no longer adds the vehicle directly — it starts a
// one-time $17.50 Stripe Checkout payment and sends the browser there. The
// vehicle only actually gets created after Stripe confirms payment (see the
// webhook handler in server.js); this page picks the flow back up in
// handleCheckoutReturn() below once Stripe redirects back to us.
document.getElementById('addVehicleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('addVehicleError');
  errorEl.textContent = '';
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const body = {
    plate: document.getElementById('vPlate').value,
    label: document.getElementById('vLabel').value,
    driver: document.getElementById('vDriver').value || undefined,
    fuelType: document.getElementById('vFuelType').value,
  };
  submitBtn.disabled = true;
  try {
    const res = await authedFetch('/api/vehicles/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorEl.textContent = data.error || 'Could not add vehicle.';
      submitBtn.disabled = false;
      return;
    }
    if (data.checkoutUrl) {
      // Billing enabled — redirect to Stripe's hosted payment page.
      window.location.href = data.checkoutUrl;
      return; // leaving the page; no need to re-enable the button
    }
    // Billing not configured on this deployment — server added the vehicle
    // directly with no payment step (see POST /api/vehicles in server.js).
    e.target.reset();
    await loadFleetTab();
    submitBtn.disabled = false;
  } catch (err) {
    errorEl.textContent = 'Could not start payment. Please try again.';
    submitBtn.disabled = false;
  }
});

// Stripe redirects back to `${APP_BASE_URL}/?vehicleAdded=1&session_id=...`
// (success) or `/?vehicleCancelled=1` (cancel/back button) — see
// success_url/cancel_url in lib/billing.js's createVehicleAddCheckoutSession.
// The webhook usually creates the vehicle within a second or two of payment,
// but can lag slightly behind this redirect, so on success we poll
// GET /api/vehicles briefly rather than assuming it's there on the first load.
async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const added = params.get('vehicleAdded') === '1';
  const cancelled = params.get('vehicleCancelled') === '1';
  if (!added && !cancelled) return;

  // Clean the URL immediately so a page refresh doesn't re-trigger this.
  window.history.replaceState({}, '', window.location.pathname);

  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="fleet"]').classList.add('active');
  document.body.classList.remove('map-mode');
  document.getElementById('tab-fleet').classList.add('active');

  const statusEl = document.getElementById('fleetStatusMsg');
  if (cancelled) {
    statusEl.textContent = 'Payment cancelled — no vehicle was added.';
    statusEl.className = 'hint error';
    await loadFleetTab();
    return;
  }

  statusEl.textContent = 'Payment received — adding your vehicle…';
  statusEl.className = 'hint success';
  const countBefore = (await (await authedFetch('/api/vehicles')).json()).length;
  for (let attempt = 0; attempt < 6; attempt++) {
    await loadFleetTab();
    const vehicles = await (await authedFetch('/api/vehicles')).json();
    if (vehicles.length > countBefore) {
      statusEl.textContent = 'Vehicle added — your subscription now includes it.';
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  statusEl.textContent = 'Payment received — still finalizing, refresh in a moment if it doesn’t appear.';
}

// ---------------------------------------------------------------------------
// Geofencing tab
// ---------------------------------------------------------------------------
function renderGeofenceList() {
  const list = document.getElementById('geofenceList');
  list.innerHTML = state.geofences
    .map(
      (gf) => `
    <div class="geofence-card">
      <div>
        <div>${gf.name} <span class="gf-type ${gf.type}">${gf.type}</span></div>
        <div class="meta">${gf.lat.toFixed(4)}, ${gf.lng.toFixed(4)} · radius ${gf.radiusM} m</div>
      </div>
      <button data-id="${gf.id}">Remove</button>
    </div>`
    )
    .join('');
  list.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await authedFetch(`/api/geofences/${btn.dataset.id}`, { method: 'DELETE' });
      state.geofences = state.geofences.filter((g) => g.id !== btn.dataset.id);
      renderGeofenceList();
      renderGeofences();
    });
  });
}

document.getElementById('geofenceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById('gfName').value,
    lat: parseFloat(document.getElementById('gfLat').value),
    lng: parseFloat(document.getElementById('gfLng').value),
    radiusM: parseFloat(document.getElementById('gfRadius').value),
    type: document.getElementById('gfType').value,
  };
  const res = await authedFetch('/api/geofences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const gf = await res.json();
  state.geofences.push(gf);
  renderGeofenceList();
  renderGeofences();
  e.target.reset();
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    document.getElementById('connStatus').classList.add('connected');
    document.getElementById('connText').textContent = 'Live';
  };
  ws.onclose = () => {
    document.getElementById('connStatus').classList.remove('connected');
    document.getElementById('connText').textContent = 'Reconnecting…';
    setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'init') {
      for (const v of msg.vehicles) state.vehicles.set(v.id, v);
      state.geofences = msg.geofences;
      state.alerts = msg.alerts;
      refreshAllMarkers();
      renderGeofences();
      renderGeofenceList();
      renderVehicleList();
      renderAlerts();
      if (msg.vehicles.length) fitFleet();
    } else if (msg.type === 'positions') {
      for (const v of msg.vehicles) state.vehicles.set(v.id, v);
      refreshAllMarkers();
      renderVehicleList();
    } else if (msg.type === 'alert') {
      state.alerts.unshift(msg.alert);
      if (state.alerts.length > 500) state.alerts.length = 500;
      renderAlerts();
    }
  };
}

connect();
handleCheckoutReturn();
