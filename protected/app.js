// Fleet Shield — JEGASEC
// Connects to the backend over WebSocket for live positions/alerts,
// and REST for geofences + reports.

// Session-aware fetch wrapper — if the session has expired server-side,
// every API call starts 401ing; bounce back to the login page instead of
// silently failing.
async function authedFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('unauthenticated');
  }
  return res;
}

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
    if (btn.dataset.tab === 'map') setTimeout(() => map.invalidateSize(), 50);
  });
});

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------
const map = L.map('map').setView([-37.8136, 144.9631], 10);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  maxZoom: 19,
}).addTo(map);

// Keep the map filling its container correctly across phone/tablet
// orientation changes and window resizes (in addition to the tab-switch
// invalidateSize() call above, which handles the display:none case).
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => map.invalidateSize(), 150);
});

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
