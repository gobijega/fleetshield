// Fleet Shield: Alerts tab (triage workflow).
//
// Loaded after app.js and shares its globals (state, map, authedFetch,
// escapeHtml, plateBadge, selectVehicle). Live alerts still arrive over the
// WebSocket in app.js, which calls renderAlerts(); this file owns the view:
//
//   - summary for the selected period (open, high, acknowledged, resolved,
//     median time to acknowledge, busiest vehicle) and an hourly chart
//   - filters: status, severity, category, vehicle, period, search
//   - repeats grouped (same vehicle and alert type within 30 minutes)
//   - acknowledge / resolve with a reason / reopen, singly or in bulk,
//     persisted server-side and audit-logged
//   - a detail drawer with history, the vehicle's recent alerts, and a jump
//     to the alert's location on the live map
//   - CSV export of what is shown, and j/k/Enter/a/Esc keyboard triage
/* global state, map, escapeHtml, plateBadge, selectVehicle */

(function () {
  'use strict';

  const CATEGORY_OF = {
    speeding: 'safety',
    harsh_braking: 'safety',
    harsh_acceleration: 'safety',
    excessive_idling: 'safety',
    geofence_entry: 'geofence',
    geofence_exit: 'geofence',
    geofence_restricted_entry: 'geofence',
    gps_jump: 'assurance',
    gps_signal_loss: 'assurance',
    device_tamper: 'assurance',
    odometer_mismatch: 'assurance',
    after_hours_movement: 'assurance',
  };
  const CATEGORY_LABEL = {
    safety: 'Driver safety',
    geofence: 'Geofence',
    assurance: 'Data assurance',
    other: 'Other',
  };
  const TYPE_LABEL = {
    speeding: 'Speeding',
    harsh_braking: 'Harsh braking',
    harsh_acceleration: 'Harsh acceleration',
    excessive_idling: 'Excessive idling',
    geofence_entry: 'Geofence entry',
    geofence_exit: 'Geofence exit',
    geofence_restricted_entry: 'Restricted zone entry',
    gps_jump: 'Possible GPS spoofing',
    gps_signal_loss: 'GPS signal lost',
    device_tamper: 'Device power disconnected',
    odometer_mismatch: 'Odometer mismatch',
    after_hours_movement: 'After-hours movement',
  };
  const RESOLUTION_LABEL = {
    confirmed: 'Confirmed: action taken',
    explained: 'Explained: expected behaviour',
    false_alarm: 'False alarm',
    duplicate: 'Duplicate',
  };
  const GROUP_WINDOW_MS = 30 * 60 * 1000;

  const ui = {
    status: 'open',
    sev: new Set(['high', 'medium', 'low', 'info']),
    category: 'all',
    vehicle: 'all',
    hours: 24,
    search: '',
    group: true,
    selected: new Set(), // alert ids ticked for bulk actions
    expanded: new Set(), // group keys expanded
    openId: null, // alert shown in the drawer
    cursor: -1, // keyboard row index
    loadedHours: 0,
    fresh: new Set(), // ids that arrived live, highlighted briefly
    flashed: new Set(), // ids already highlighted once (re-renders must not replay it)
  };

  const $ = (id) => document.getElementById(id);
  const tab = $('tab-alerts');
  if (!tab) return;

  // ------------------------------------------------------------------ data
  const byId = () => new Map(state.alerts.map((a) => [a.id, a]));
  const categoryOf = (t) => CATEGORY_OF[t] || 'other';
  const typeLabel = (t) => TYPE_LABEL[t] || String(t || '').replace(/_/g, ' ');
  const vehicleOf = (a) => (a.vehicleId ? state.vehicles.get(a.vehicleId) : null);

  function merge(list) {
    const map = byId();
    for (const a of list) map.set(a.id, { ...(map.get(a.id) || {}), ...a });
    state.alerts = Array.from(map.values()).sort((x, y) => new Date(y.t) - new Date(x.t));
  }

  async function load(hours) {
    if (hours <= ui.loadedHours) return;
    try {
      const res = await authedFetch(`/api/alerts?hours=${hours}&limit=1000`);
      if (!res.ok) return;
      merge(await res.json());
      ui.loadedHours = hours;
      render();
    } catch (err) {
      console.error('Failed to load alerts', err);
    }
  }

  function inPeriod(a) {
    return Date.now() - new Date(a.t).getTime() <= ui.hours * 3600 * 1000;
  }

  function matches(a) {
    if (!inPeriod(a)) return false;
    if (!ui.sev.has(a.severity)) return false;
    if (ui.category !== 'all' && categoryOf(a.type) !== ui.category) return false;
    if (ui.vehicle !== 'all' && a.vehicleId !== ui.vehicle) return false;
    if (ui.search) {
      const v = vehicleOf(a);
      const hay = [
        a.message,
        a.vehicleLabel,
        typeLabel(a.type),
        v && v.plate,
        v && v.driver,
        v && v.label,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(ui.search)) return false;
    }
    return true;
  }

  function statusOk(a) {
    return ui.status === 'all' || (a.status || 'open') === ui.status;
  }

  // Collapse repeats: same vehicle + type within 30 minutes of the group's
  // most recent alert. Rows keep newest-first order.
  function groupRows(list) {
    if (!ui.group) return list.map((a) => ({ key: a.id, items: [a] }));
    const groups = [];
    const open = new Map();
    for (const a of list) {
      const k = `${a.vehicleId || a.vehicleLabel}|${a.type}|${a.status || 'open'}`;
      const g = open.get(k);
      const t = new Date(a.t).getTime();
      if (g && g.oldest - t <= GROUP_WINDOW_MS) {
        g.items.push(a);
        g.oldest = t;
      } else {
        const ng = { key: a.id, items: [a], oldest: t };
        groups.push(ng);
        open.set(k, ng);
      }
    }
    return groups;
  }

  // ---------------------------------------------------------------- format
  function rel(t) {
    const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  const abs = (t) => new Date(t).toLocaleString();
  function dur(ms) {
    if (!isFinite(ms)) return '—';
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60} min`;
  }
  function statusPill(a) {
    const s = a.status || 'open';
    return `<span class="al-status al-status--${s}">${s}</span>`;
  }
  function vehicleCell(a) {
    const v = vehicleOf(a);
    if (v && v.plate)
      return `${plateBadge(v)} <span class="vp-muted">${escapeHtml(v.label)}</span>`;
    return escapeHtml(a.vehicleLabel || '—');
  }

  // --------------------------------------------------------------- summary
  function renderSummary(list) {
    const open = list.filter((a) => (a.status || 'open') === 'open');
    const highOpen = open.filter((a) => a.severity === 'high').length;
    const ack = list.filter((a) => a.status === 'acknowledged').length;
    const res = list.filter((a) => a.status === 'resolved').length;
    const ackTimes = list
      .filter((a) => a.acknowledgedAt)
      .map((a) => new Date(a.acknowledgedAt) - new Date(a.t))
      .filter((x) => x >= 0)
      .sort((x, y) => x - y);
    const median = ackTimes.length ? ackTimes[Math.floor(ackTimes.length / 2)] : NaN;
    const perVehicle = new Map();
    for (const a of list) {
      const k = a.vehicleId || a.vehicleLabel;
      if (k) perVehicle.set(k, (perVehicle.get(k) || 0) + 1);
    }
    const top = [...perVehicle.entries()].sort((x, y) => y[1] - x[1])[0];
    const topV = top ? state.vehicles.get(top[0]) : null;
    const topLabel = top ? (topV && topV.plate) || topV?.label || top[0] : '—';
    const period = { 1: 'last hour', 24: 'last 24 h', 168: 'last 7 days', 720: 'last 30 days' }[
      ui.hours
    ];

    const card = (value, label, cls = '') =>
      `<div class="al-card ${cls}"><div class="v">${value}</div><div class="l">${label}</div></div>`;
    $('alSummary').innerHTML =
      card(open.length, `Open · ${period}`, open.length ? 'al-card--open' : '') +
      card(highOpen, 'High severity, open', highOpen ? 'al-card--high' : '') +
      card(ack, 'Acknowledged') +
      card(res, 'Resolved') +
      card(dur(median), 'Median time to acknowledge') +
      card(top ? `${escapeHtml(topLabel)} <small>×${top[1]}</small>` : '—', 'Most alerts') +
      `<div class="al-card al-card--chart">${histogram(list)}<div class="l">Alerts per ${ui.hours > 24 ? 'day' : 'hour'}, by severity</div></div>`;
  }

  function histogram(list) {
    const bins = ui.hours > 24 ? Math.round(ui.hours / 24) : Math.max(ui.hours, 1) === 1 ? 12 : 24;
    const span = ui.hours * 3600 * 1000;
    const binMs = span / bins;
    const now = Date.now();
    const data = Array.from({ length: bins }, () => ({ high: 0, medium: 0, low: 0, info: 0 }));
    for (const a of list) {
      const i = bins - 1 - Math.floor((now - new Date(a.t).getTime()) / binMs);
      if (i >= 0 && i < bins && data[i][a.severity] != null) data[i][a.severity]++;
    }
    const max = Math.max(1, ...data.map((d) => d.high + d.medium + d.low + d.info));
    const W = 220;
    const H = 44;
    const bw = W / bins;
    const colors = {
      high: 'var(--red)',
      medium: 'var(--amber)',
      low: 'var(--accent)',
      info: '#94a3b8',
    };
    let bars = '';
    data.forEach((d, i) => {
      let y = H;
      for (const s of ['info', 'low', 'medium', 'high']) {
        if (!d[s]) continue;
        const h = (d[s] / max) * (H - 2);
        y -= h;
        bars += `<rect x="${(i * bw + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${colors[s]}"/>`;
      }
    });
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="al-hist" role="img" aria-label="Alert counts over the selected period">${bars}<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="#cbd5e1"/></svg>`;
  }

  // ----------------------------------------------------------------- table
  let shownGroups = [];

  function render() {
    renderVehicleOptions();
    const scoped = state.alerts.filter(matches);
    renderSummary(scoped);
    const list = scoped.filter(statusOk).sort((x, y) => new Date(y.t) - new Date(x.t));
    shownGroups = groupRows(list).slice(0, 300);

    const rows = [];
    for (const g of shownGroups) {
      const a = g.items[0];
      const n = g.items.length;
      const expanded = ui.expanded.has(g.key);
      rows.push(rowHtml(a, { count: n, groupKey: g.key, expanded }));
      if (n > 1 && expanded)
        for (const sub of g.items.slice(1)) rows.push(rowHtml(sub, { child: true }));
    }
    $('alertRows').innerHTML = rows.join('');
    $('alEmpty').hidden = rows.length > 0;
    $('alertCount').textContent = state.alerts.filter(
      (a) => (a.status || 'open') === 'open'
    ).length;
    const allIds = shownGroups.flatMap((g) => g.items.map((a) => a.id));
    $('alSelectAll').checked = allIds.length > 0 && allIds.every((id) => ui.selected.has(id));
    renderBulk();
    if (ui.openId) renderDrawer();
    highlightCursor();
  }

  function rowHtml(a, { count = 1, groupKey = null, expanded = false, child = false } = {}) {
    const s = a.status || 'open';
    const ids = groupKey
      ? shownGroups.find((g) => g.key === groupKey).items.map((x) => x.id)
      : [a.id];
    const checked = ids.every((id) => ui.selected.has(id));
    const fresh = ui.fresh.has(a.id) && !ui.flashed.has(a.id) ? ' al-fresh' : '';
    if (fresh) ui.flashed.add(a.id);
    const openCls = ui.openId === a.id ? ' al-row--open' : '';
    const repeat =
      count > 1
        ? `<button type="button" class="al-repeat" data-expand="${groupKey}" aria-expanded="${expanded}">×${count} in ${dur(new Date(a.t) - new Date(shownGroups.find((g) => g.key === groupKey).items[count - 1].t)) === '0 min' ? '&lt;1 min' : dur(new Date(a.t) - new Date(shownGroups.find((g) => g.key === groupKey).items[count - 1].t))}</button>`
        : '';
    const icon = {
      ack: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>',
      resolve:
        '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M5.3 8.2l1.9 1.9 3.6-3.8"/></svg>',
      view: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5"/></svg>',
    };
    // Text labels, not icons alone, so nobody has to guess what a tick means.
    const btn = (attr, kind, label, title) =>
      `<button type="button" class="al-ico al-ico--txt al-ico--${kind}" ${attr} title="${title}">${icon[kind]}<span>${label}</span></button>`;
    const actions =
      s === 'open'
        ? btn(
            `data-act="acknowledge" data-id="${a.id}"`,
            'ack',
            'Seen',
            'Mark as seen (acknowledge)'
          ) + btn(`data-open="${a.id}"`, 'resolve', 'Resolve', 'Close this alert with a reason')
        : s === 'acknowledged'
          ? btn(`data-open="${a.id}"`, 'resolve', 'Resolve', 'Close this alert with a reason')
          : btn(`data-open="${a.id}"`, 'view', 'Details', 'View details');
    return `<tr class="al-row al-sev-${a.severity}${child ? ' al-child' : ''}${fresh}${openCls}" data-row="${a.id}" data-ids="${ids.join(',')}">
      <td class="al-cb"><input type="checkbox" data-select="${ids.join(',')}" ${checked ? 'checked' : ''} aria-label="Select alert" /></td>
      <td title="${escapeHtml(abs(a.t))}"><span class="al-time">${new Date(a.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span><span class="al-rel">${rel(a.t)}</span></td>
      <td>${vehicleCell(a)}</td>
      <td class="al-msg"><span class="al-type">${escapeHtml(typeLabel(a.type))}<span class="al-cat">${CATEGORY_LABEL[categoryOf(a.type)]}</span></span><span class="al-text">${escapeHtml(a.message || '')}</span>${repeat}</td>
      <td><span class="sev sev-${a.severity}">${escapeHtml(String(a.severity || '').replace(/^./, (c) => c.toUpperCase()))}</span></td>
      <td>${statusPill(a)}</td>
      <td class="al-act"><div class="al-acts">${actions}</div></td>
    </tr>`;
  }

  function renderVehicleOptions() {
    const sel = $('alVehicle');
    const want = ['all', ...Array.from(state.vehicles.values()).map((v) => v.id)].join('|');
    if (sel.dataset.sig === want) return;
    sel.dataset.sig = want;
    const cur = sel.value;
    sel.innerHTML =
      '<option value="all">All vehicles</option>' +
      Array.from(state.vehicles.values())
        .sort((x, y) => String(x.plate || x.label).localeCompare(String(y.plate || y.label)))
        .map(
          (v) =>
            `<option value="${escapeHtml(v.id)}">${escapeHtml(v.plate || v.label)}${v.plate ? ` · ${escapeHtml(v.label)}` : ''}</option>`
        )
        .join('');
    sel.value = cur && sel.querySelector(`option[value="${CSS.escape(cur)}"]`) ? cur : 'all';
  }

  // ---------------------------------------------------------------- drawer
  function renderDrawer() {
    const a = byId().get(ui.openId);
    const d = $('alDrawer');
    if (!a) {
      d.hidden = true;
      return;
    }
    const v = vehicleOf(a);
    const s = a.status || 'open';
    const recent = state.alerts
      .filter((x) => x.id !== a.id && x.vehicleId && x.vehicleId === a.vehicleId)
      .slice(0, 6);
    const history = [`<li><b>Raised</b> ${escapeHtml(abs(a.t))}</li>`];
    if (a.acknowledgedAt)
      history.push(
        `<li><b>Acknowledged</b> ${escapeHtml(abs(a.acknowledgedAt))} by ${escapeHtml(a.acknowledgedBy || '—')}</li>`
      );
    if (a.resolvedAt)
      history.push(
        `<li><b>Resolved</b> ${escapeHtml(abs(a.resolvedAt))} by ${escapeHtml(a.resolvedBy || '—')}: ${escapeHtml(RESOLUTION_LABEL[a.resolution] || a.resolution || '')}</li>`
      );
    const resolveForm =
      s === 'resolved'
        ? `<button type="button" class="al-btn" data-act="reopen" data-id="${a.id}">Reopen</button>`
        : `<form class="al-resolve" data-resolve="${a.id}">
            <label>Resolution
              <select name="resolution" required>
                <option value="">Choose…</option>
                ${Object.entries(RESOLUTION_LABEL)
                  .map(([k, l]) => `<option value="${k}">${l}</option>`)
                  .join('')}
              </select>
            </label>
            <label>Note <span class="vp-muted">(optional)</span>
              <textarea name="note" rows="3" maxlength="1000" placeholder="What did you find or do?">${escapeHtml(a.note || '')}</textarea>
            </label>
            <div class="al-drawer-actions">
              ${s === 'open' ? `<button type="button" class="al-btn" data-act="acknowledge" data-id="${a.id}">Acknowledge</button>` : ''}
              <button type="submit" class="al-btn al-btn--primary">Resolve</button>
            </div>
          </form>`;
    d.innerHTML = `
      <div class="al-drawer-head">
        <div>
          <span class="sev sev-${a.severity}">${a.severity}</span> ${statusPill(a)}
          <h3>${escapeHtml(typeLabel(a.type))}</h3>
          <p class="al-drawer-msg">${escapeHtml(a.message || '')}</p>
        </div>
        <button type="button" class="al-close" data-close aria-label="Close alert detail">×</button>
      </div>
      <dl class="al-dl">
        <div><dt>Vehicle</dt><dd>${vehicleCell(a)}</dd></div>
        ${v && v.driver ? `<div><dt>Driver</dt><dd>${escapeHtml(v.driver)}</dd></div>` : ''}
        <div><dt>Category</dt><dd>${CATEGORY_LABEL[categoryOf(a.type)]}</dd></div>
        <div><dt>Raised</dt><dd>${escapeHtml(abs(a.t))} <span class="vp-muted">(${rel(a.t)})</span></dd></div>
        <div><dt>Location</dt><dd>${a.lat != null ? `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}` : '—'}</dd></div>
        ${a.resolution ? `<div><dt>Resolution</dt><dd>${escapeHtml(RESOLUTION_LABEL[a.resolution] || a.resolution)}</dd></div>` : ''}
        ${a.note && s === 'resolved' ? `<div><dt>Note</dt><dd>${escapeHtml(a.note)}</dd></div>` : ''}
      </dl>
      ${a.lat != null ? `<button type="button" class="al-btn al-btn--ghost al-mapjump" data-map="${a.id}">Show on live map</button>` : ''}
      ${resolveForm}
      <h4>History</h4>
      <ul class="al-history">${history.join('')}</ul>
      <h4>Recent alerts for this vehicle</h4>
      ${
        recent.length
          ? `<ul class="al-recent">${recent
              .map(
                (x) =>
                  `<li><button type="button" data-goto="${x.id}"><span class="sev sev-${x.severity}">${x.severity}</span> ${escapeHtml(typeLabel(x.type))} <span class="vp-muted">${rel(x.t)}</span></button></li>`
              )
              .join('')}</ul>`
          : '<p class="hint">None loaded for this period.</p>'
      }`;
    d.hidden = false;
  }

  function openDrawer(id) {
    ui.openId = id;
    render();
    const d = $('alDrawer');
    if (window.matchMedia('(max-width: 1100px)').matches)
      d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeDrawer() {
    ui.openId = null;
    $('alDrawer').hidden = true;
    render();
  }

  // --------------------------------------------------------------- actions
  function live(msg) {
    $('alLive').textContent = msg;
    clearTimeout(live.t);
    live.t = setTimeout(() => ($('alLive').textContent = ''), 4000);
  }

  async function act(id, action, extra = {}) {
    try {
      const res = await authedFetch(`/api/alerts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        live(body.error || 'Update failed');
        return;
      }
      merge([body]);
      live(
        action === 'acknowledge'
          ? 'Alert acknowledged'
          : action === 'resolve'
            ? 'Alert resolved'
            : 'Alert reopened'
      );
      render();
    } catch (err) {
      console.error(err);
      live('Update failed');
    }
  }

  async function bulk(action, resolution) {
    const ids = [...ui.selected];
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += 200) {
      const res = await authedFetch('/api/alerts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: ids.slice(i, i + 200),
          action,
          ...(resolution ? { resolution } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        live(body.error || 'Bulk update failed');
        return;
      }
      merge(body.updated || []);
      const skipped = (body.skipped || []).length;
      live(`${(body.updated || []).length} updated${skipped ? `, ${skipped} skipped` : ''}`);
    }
    ui.selected.clear();
    render();
  }

  function renderBulk() {
    const n = ui.selected.size;
    $('alBulk').hidden = n === 0;
    $('alBulkCount').textContent = `${n} selected`;
  }

  function exportCsv() {
    const list = state.alerts.filter(matches).filter(statusOk);
    const cols = [
      'time',
      'plate',
      'vehicle',
      'category',
      'type',
      'severity',
      'status',
      'message',
      'lat',
      'lng',
      'acknowledged_at',
      'acknowledged_by',
      'resolved_at',
      'resolved_by',
      'resolution',
      'note',
    ];
    const q = (x) => {
      let s = x == null ? '' : String(x);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [cols.join(',')];
    for (const a of list) {
      const v = vehicleOf(a);
      lines.push(
        [
          new Date(a.t).toISOString(),
          v && v.plate,
          (v && v.label) || a.vehicleLabel,
          CATEGORY_LABEL[categoryOf(a.type)],
          typeLabel(a.type),
          a.severity,
          a.status || 'open',
          a.message,
          a.lat,
          a.lng,
          a.acknowledgedAt,
          a.acknowledgedBy,
          a.resolvedAt,
          a.resolvedBy,
          a.resolution && RESOLUTION_LABEL[a.resolution],
          a.note,
        ]
          .map(q)
          .join(',')
      );
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `fleet-shield-alerts-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  let mapPin = null;
  function showOnMap(id) {
    const a = byId().get(id);
    if (!a || a.lat == null) return;
    document.querySelector('.tab-btn[data-tab="map"]').click();
    setTimeout(() => {
      map.setView([a.lat, a.lng], Math.max(map.getZoom(), 15));
      if (mapPin) map.removeLayer(mapPin);
      mapPin = L.circleMarker([a.lat, a.lng], {
        radius: 14,
        color: a.severity === 'high' ? '#dc2626' : '#d97706',
        weight: 2,
        fillOpacity: 0.12,
        dashArray: '3 3',
      })
        .bindTooltip(`${typeLabel(a.type)} · ${abs(a.t)}`, {
          permanent: true,
          direction: 'top',
          offset: [0, -14],
        })
        .addTo(map);
      setTimeout(() => {
        if (mapPin) {
          map.removeLayer(mapPin);
          mapPin = null;
        }
      }, 12000);
      if (a.vehicleId && state.vehicles.has(a.vehicleId) && typeof selectVehicle === 'function') {
        selectVehicle(a.vehicleId, { pan: false });
      }
    }, 120);
  }

  // ---------------------------------------------------------------- events
  $('alStatus').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-status]');
    if (!b) return;
    ui.status = b.dataset.status;
    $('alStatus')
      .querySelectorAll('button')
      .forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
    ui.cursor = -1;
    render();
  });
  $('alSev').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sev]');
    if (!b) return;
    const s = b.dataset.sev;
    if (ui.sev.has(s) && ui.sev.size > 1) ui.sev.delete(s);
    else ui.sev.add(s);
    $('alSev')
      .querySelectorAll('button')
      .forEach((x) => {
        const on = ui.sev.has(x.dataset.sev);
        x.classList.toggle('active', on);
        x.setAttribute('aria-pressed', String(on));
      });
    render();
  });
  $('alCategory').addEventListener('change', (e) => {
    ui.category = e.target.value;
    render();
  });
  $('alVehicle').addEventListener('change', (e) => {
    ui.vehicle = e.target.value;
    render();
  });
  $('alPeriod').addEventListener('change', (e) => {
    ui.hours = parseInt(e.target.value, 10);
    render();
    load(ui.hours);
  });
  $('alSearch').addEventListener('input', (e) => {
    ui.search = e.target.value.trim().toLowerCase();
    render();
  });
  $('alGroup').addEventListener('change', (e) => {
    ui.group = e.target.checked;
    render();
  });
  $('alExport').addEventListener('click', exportCsv);
  $('alSelectAll').addEventListener('change', (e) => {
    const ids = shownGroups.flatMap((g) => g.items.map((a) => a.id));
    ids.forEach((id) => (e.target.checked ? ui.selected.add(id) : ui.selected.delete(id)));
    render();
  });
  $('alBulk').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulk]');
    if (b) bulk(b.dataset.bulk);
  });
  $('alBulkResolution').addEventListener('change', (e) => {
    if (e.target.value) bulk('resolve', e.target.value);
    e.target.value = '';
  });
  $('alBulkClear').addEventListener('click', () => {
    ui.selected.clear();
    render();
  });

  $('alertRows').addEventListener('click', (e) => {
    const cb = e.target.closest('input[data-select]');
    if (cb) {
      cb.dataset.select
        .split(',')
        .forEach((id) => (cb.checked ? ui.selected.add(id) : ui.selected.delete(id)));
      render();
      return;
    }
    const ex = e.target.closest('[data-expand]');
    if (ex) {
      const k = ex.dataset.expand;
      ui.expanded.has(k) ? ui.expanded.delete(k) : ui.expanded.add(k);
      render();
      return;
    }
    const a = e.target.closest('[data-act]');
    if (a) {
      act(a.dataset.id, a.dataset.act);
      return;
    }
    const o = e.target.closest('[data-open]');
    if (o) {
      openDrawer(o.dataset.open);
      return;
    }
    const row = e.target.closest('tr[data-row]');
    if (row && !e.target.closest('a, button, input, select')) openDrawer(row.dataset.row);
  });

  $('alDrawer').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeDrawer();
    const a = e.target.closest('[data-act]');
    if (a) return act(a.dataset.id, a.dataset.act);
    const m = e.target.closest('[data-map]');
    if (m) return showOnMap(m.dataset.map);
    const g = e.target.closest('[data-goto]');
    if (g) return openDrawer(g.dataset.goto);
  });
  $('alDrawer').addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-resolve]');
    if (!f) return;
    e.preventDefault();
    const resolution = f.elements.resolution.value;
    if (!resolution) {
      f.elements.resolution.focus();
      return;
    }
    act(f.dataset.resolve, 'resolve', { resolution, note: f.elements.note.value });
  });

  // Keyboard triage, only while the Alerts tab is showing and focus isn't in
  // a form field.
  function rowsEls() {
    return Array.from($('alertRows').querySelectorAll('tr[data-row]'));
  }
  function highlightCursor() {
    rowsEls().forEach((r, i) => r.classList.toggle('al-row--cursor', i === ui.cursor));
  }
  document.addEventListener('keydown', (e) => {
    if (!tab.classList.contains('active')) return;
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = rowsEls();
    if (e.key === 'j' || e.key === 'k') {
      if (!rows.length) return;
      ui.cursor = Math.max(0, Math.min(rows.length - 1, ui.cursor + (e.key === 'j' ? 1 : -1)));
      highlightCursor();
      rows[ui.cursor].scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    } else if (e.key === 'Enter' && ui.cursor >= 0 && rows[ui.cursor]) {
      openDrawer(rows[ui.cursor].dataset.row);
      e.preventDefault();
    } else if (e.key === 'a' && ui.cursor >= 0 && rows[ui.cursor]) {
      const a = byId().get(rows[ui.cursor].dataset.row);
      if (a && (a.status || 'open') === 'open') act(a.id, 'acknowledge');
    } else if (e.key === 'Escape' && ui.openId) {
      closeDrawer();
    }
  });

  // --------------------------------------------------------- live updates
  // app.js calls renderAlerts() after init and after each live alert; it
  // calls onAlertUpdate() for workflow changes made by other users.
  let lastSeen = null;
  window.renderAlerts = function () {
    const newest = state.alerts[0];
    if (lastSeen && newest && newest.id !== lastSeen) {
      for (const a of state.alerts) {
        if (a.id === lastSeen) break;
        ui.fresh.add(a.id);
        setTimeout(() => ui.fresh.delete(a.id), 4000);
      }
    }
    lastSeen = newest ? newest.id : lastSeen;
    if (tab.classList.contains('active')) render();
    else
      $('alertCount').textContent = state.alerts.filter(
        (a) => (a.status || 'open') === 'open'
      ).length;
  };
  window.onAlertUpdate = function (alert) {
    merge([alert]);
    window.renderAlerts();
  };

  // Called by showTab() in app.js whenever the Alerts page opens.
  window.loadAlertsTab = function () {
    render();
    load(Math.max(ui.hours, 24));
  };
  // Load the last 24 hours up front so the sidebar badge counts every open
  // alert from today, not just the 50 the live feed sends on connect.
  load(24);

  setInterval(() => {
    if (tab.classList.contains('active')) render(); // keep "x min ago" current
  }, 60000);
})();
