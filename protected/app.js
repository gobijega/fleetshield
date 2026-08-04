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

const state = {
  vehicles: new Map(),
  markers: new Map(),
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
    if (btn.dataset.tab === 'reports') loadReports();
    if (btn.dataset.tab === 'compliance') loadCompliance();
    if (btn.dataset.tab === 'fleet') loadFleetTab();
    if (btn.dataset.tab === 'import') loadImportHistory();
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
const map = L.map('map').setView([-37.8136, 144.9631], 10);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  maxZoom: 19,
}).addTo(map);

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

function statusColor(status) {
  return status === 'idling' ? '#f2a93b' : '#35c26f';
}

function upsertMarker(v) {
  let marker = state.markers.get(v.id);
  const popupHtml = `<b>${v.label}</b><br/>Driver: ${v.driver}<br/>Speed: ${v.speedKmh} km/h (limit ${v.speedLimit})<br/>Status: ${v.status}<br/>Odometer: ${v.odometerKm} km<br/>Fuel: ${v.fuelType.toUpperCase()} · CO2: ${v.co2Kg} kg<br/>Utilisation: ${v.utilisationPct}% · Safety: ${v.safetyScore}`;
  if (!marker) {
    marker = L.circleMarker([v.lat, v.lng], {
      radius: 7,
      color: statusColor(v.status),
      fillColor: statusColor(v.status),
      fillOpacity: 0.9,
      weight: 2,
    }).addTo(map);
    marker.bindPopup(popupHtml);
    state.markers.set(v.id, marker);
  } else {
    marker.setLatLng([v.lat, v.lng]);
    marker.setStyle({ color: statusColor(v.status), fillColor: statusColor(v.status) });
    marker.setPopupContent(popupHtml);
  }
}

function renderGeofences() {
  for (const layer of state.geofenceLayers.values()) map.removeLayer(layer);
  state.geofenceLayers.clear();
  for (const gf of state.geofences) {
    const color = gf.type === 'restricted' ? '#ef5757' : gf.type === 'depot' ? '#35c26f' : '#4f8cff';
    const circle = L.circle([gf.lat, gf.lng], {
      radius: gf.radiusM,
      color,
      fillColor: color,
      fillOpacity: 0.08,
      weight: 1.5,
    }).addTo(map);
    circle.bindTooltip(gf.name, { permanent: false });
    state.geofenceLayers.set(gf.id, circle);
  }
}

// ---------------------------------------------------------------------------
// Vehicle sidebar
// ---------------------------------------------------------------------------
function renderVehicleList() {
  const container = document.getElementById('vehicleItems');
  document.getElementById('fleetCount').textContent = state.vehicles.size;
  container.innerHTML = '';
  const sorted = Array.from(state.vehicles.values()).sort((a, b) => a.id.localeCompare(b.id));
  for (const v of sorted) {
    const el = document.createElement('div');
    el.className = 'vehicle-item';
    el.innerHTML = `
      <div class="row1"><span>${v.label}</span><span class="status-pill status-${v.status}">${v.status}</span></div>
      <div class="row2">${v.driver} · ${v.speedKmh} km/h · ${v.odometerKm} km</div>
    `;
    el.addEventListener('click', () => {
      map.setView([v.lat, v.lng], 13);
      state.markers.get(v.id)?.openPopup();
    });
    container.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
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
        <td>${a.vehicleLabel || '—'}</td>
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
// Reports
// ---------------------------------------------------------------------------
let alertChart, distanceChart, emissionsChart, utilisationChart;

async function loadReports() {
  const res = await authedFetch('/api/reports/summary');
  const data = await res.json();

  document.getElementById('summaryCards').innerHTML = `
    <div class="card"><div class="value">${data.fleetSize}</div><div class="label">Vehicles in fleet</div></div>
    <div class="card"><div class="value">${data.totalDistanceKm}</div><div class="label">Total distance (km)</div></div>
    <div class="card"><div class="value">${data.avgSpeedKmh}</div><div class="label">Avg speed (km/h)</div></div>
    <div class="card"><div class="value">${data.vehiclesIdling}</div><div class="label">Vehicles idling</div></div>
    <div class="card"><div class="value">${data.avgUtilisationPct}%</div><div class="label">Avg utilisation</div></div>
    <div class="card"><div class="value">${data.totalCO2Kg}</div><div class="label">Total CO2 (kg)</div></div>
    <div class="card"><div class="value">${data.totalAlerts}</div><div class="label">Total alerts</div></div>
  `;

  const alertLabels = Object.keys(data.alertCounts);
  const alertValues = Object.values(data.alertCounts);
  if (alertChart) alertChart.destroy();
  alertChart = new Chart(document.getElementById('alertChart'), {
    type: 'bar',
    data: {
      labels: alertLabels.map((l) => l.replace(/_/g, ' ')),
      datasets: [{ label: 'Count', data: alertValues, backgroundColor: '#4f8cff' }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b98af' }, grid: { color: '#2a3549' } },
        y: { ticks: { color: '#8b98af' }, grid: { color: '#2a3549' } },
      },
    },
  });

  if (distanceChart) distanceChart.destroy();
  distanceChart = new Chart(document.getElementById('distanceChart'), {
    type: 'bar',
    data: {
      labels: data.perVehicle.map((v) => v.id),
      datasets: [{ label: 'km', data: data.perVehicle.map((v) => v.odometerKm), backgroundColor: '#35c26f' }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b98af' }, grid: { color: '#2a3549' } },
        y: { ticks: { color: '#8b98af' }, grid: { color: '#2a3549' } },
      },
    },
  });

  if (emissionsChart) emissionsChart.destroy();
  emissionsChart = new Chart(document.getElementById('emissionsChart'), {
    type: 'bar',
    data: {
      labels: data.perVehicle.map((v) => v.id),
      datasets: [{ label: 'kg CO2', data: data.perVehicle.map((v) => v.co2Kg), backgroundColor: '#f2a93b' }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b98af' }, grid: { color: '#2a3549' } },
        y: { ticks: { color: '#8b98af' }, grid: { color: '#2a3549' } },
      },
    },
  });

  if (utilisationChart) utilisationChart.destroy();
  utilisationChart = new Chart(document.getElementById('utilisationChart'), {
    type: 'bar',
    data: {
      labels: data.perVehicle.map((v) => v.id),
      datasets: [{ label: '%', data: data.perVehicle.map((v) => v.utilisationPct), backgroundColor: '#4f8cff' }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b98af' }, grid: { color: '#2a3549' } },
        y: { min: 0, max: 100, ticks: { color: '#8b98af' }, grid: { color: '#2a3549' } },
      },
    },
  });

  document.getElementById('vehicleSummaryRows').innerHTML = data.perVehicle
    .map(
      (v) => `
      <tr>
        <td>${v.label}</td>
        <td>${v.driver}</td>
        <td>${v.fuelType.toUpperCase()}</td>
        <td><span class="status-pill status-${v.status}">${v.status}</span></td>
        <td>${v.speedKmh} km/h</td>
        <td>${v.odometerKm}</td>
        <td>${v.utilisationPct}%</td>
        <td>${v.co2Kg}</td>
        <td>${v.alerts}</td>
      </tr>`
    )
    .join('');
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
        <td>${v.label}</td>
        <td>${v.driver}</td>
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
    <div class="geofence-card">
      <div>
        <div>${v.label} <span class="gf-type custom">${v.fuelType.toUpperCase()}</span></div>
        <div class="meta">${v.driver || 'No driver assigned'} · ${v.id}</div>
      </div>
      <button data-id="${v.id}">Remove</button>
    </div>`
    )
    .join('') || '<p class="hint">No vehicles yet — add your first one.</p>';

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
      for (const v of msg.vehicles) upsertMarker(v);
      renderGeofences();
      renderGeofenceList();
      renderVehicleList();
      renderAlerts();
      if (msg.vehicles.length) {
        const bounds = L.latLngBounds(msg.vehicles.map((v) => [v.lat, v.lng]));
        map.fitBounds(bounds.pad(0.3));
      }
    } else if (msg.type === 'positions') {
      for (const v of msg.vehicles) {
        state.vehicles.set(v.id, v);
        upsertMarker(v);
      }
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
