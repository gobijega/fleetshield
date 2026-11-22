// Geofencing tab: a guided zone editor.
//
// Users place a zone by clicking a small map, dragging its centre,
// copying a vehicle's current position or pasting coordinates (plain
// "lat, lng" or a Google Maps link), size it with presets or a slider,
// and see which vehicles are inside before saving. Each type says what
// alert it raises. Existing zones can be shown on the live map, edited
// or removed (with an inline confirmation).
//
// Classic script after app.js; shares its globals.
/* global state, map, addBaseLayer, renderGeofences, escapeHtml, plateBadge */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TYPES = {
    depot: {
      label: 'Depot or yard',
      alert:
        'Logs each entry and exit as information, so you can see when vehicles leave and return.',
    },
    restricted: {
      label: 'Restricted zone',
      alert:
        'Raises a high-severity alert as soon as a vehicle enters. Exits are logged as information.',
    },
    custom: {
      label: 'Customer or work site',
      alert: 'Logs each entry and exit as information, for arrival and departure times on site.',
    },
  };
  const PRESETS = [
    [150, 'Yard'],
    [300, 'Depot'],
    [750, 'Site'],
    [2000, 'Suburb'],
  ];
  const MIN_R = 50;
  const MAX_R = 50000;
  const SLIDER_MAX_R = 5000;
  // GPS fixes wander by 5–15 m in the open and more between tall buildings,
  // so a zone much smaller than this flickers in and out.
  const SMALL_R = 100;

  const ui = {
    editingId: null,
    confirmingId: null,
    centre: null,
    miniMap: null,
    marker: null,
    circle: null,
    flashId: null,
  };

  function haversineM(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function vehiclesInside(centre, radiusM) {
    if (!centre || !(radiusM > 0)) return [];
    return Array.from(state.vehicles.values()).filter(
      (v) => Number.isFinite(v.lat) && haversineM(centre, v) <= radiusM
    );
  }
  function fmtRadius(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${Math.round(m)} m`;
  }
  function colourFor(type) {
    return type === 'restricted' ? '#dc2626' : type === 'depot' ? '#15803d' : '#d97706';
  }
  function alerts24h(gfId) {
    const since = Date.now() - 86400000;
    return (state.alerts || []).filter(
      (a) => a.geofenceId === gfId && new Date(a.t).getTime() >= since
    ).length;
  }

  // ------------------------------------------------------------------
  // Parsing pasted locations
  // ------------------------------------------------------------------
  function parseLocation(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const patterns = [
      /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, // google.com/maps/@lat,lng,zoom
      /[?&](?:q|query|ll)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, // ?q=lat,lng
      /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, // place links
      /^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/, // "lat, lng"
    ];
    for (const re of patterns) {
      const m = re.exec(t);
      if (m) {
        const lat = parseFloat(m[1]);
        const lng = parseFloat(m[2]);
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Mini map
  // ------------------------------------------------------------------
  function ensureMiniMap() {
    if (ui.miniMap) {
      setTimeout(() => ui.miniMap.invalidateSize(), 30);
      return;
    }
    const start = state.geofences[0] || { lat: -37.8136, lng: 144.9631 };
    ui.miniMap = L.map('gfMap', {
      zoomControl: true,
      attributionControl: true,
      minZoom: 3,
      renderer: L.canvas({ padding: 0.25 }),
    }).setView([start.lat, start.lng], 12);
    addBaseLayer(state.mapTileKey, ui.miniMap);
    // Other zones for context, dimmed.
    ui.others = L.layerGroup().addTo(ui.miniMap);
    ui.vehLayer = L.layerGroup().addTo(ui.miniMap);
    ui.miniMap.on('click', (e) => {
      setCentre({ lat: e.latlng.lat, lng: e.latlng.lng }, { pan: false });
      say('Centre placed. Drag the pin to fine-tune it.');
    });
    drawContext();
  }
  function drawContext() {
    if (!ui.miniMap) return;
    ui.others.clearLayers();
    for (const gf of state.geofences) {
      if (gf.id === ui.editingId) continue;
      L.circle([gf.lat, gf.lng], {
        radius: gf.radiusM,
        color: colourFor(gf.type),
        weight: 1,
        opacity: 0.5,
        fillOpacity: 0.03,
        dashArray: '3 5',
        interactive: false,
      }).addTo(ui.others);
    }
    ui.vehLayer.clearLayers();
    for (const v of state.vehicles.values()) {
      if (!Number.isFinite(v.lat)) continue;
      L.circleMarker([v.lat, v.lng], {
        radius: 4,
        color: '#2563eb',
        weight: 1,
        fillColor: '#2563eb',
        fillOpacity: 0.8,
      })
        .bindTooltip(v.plate || v.label, { direction: 'top', offset: [0, -4] })
        .addTo(ui.vehLayer);
    }
  }
  function radius() {
    return parseFloat($('gfRadius').value);
  }
  function type() {
    const r = document.querySelector('input[name="gfType"]:checked');
    return r ? r.value : 'depot';
  }
  function setCentre(c, { pan = true } = {}) {
    ui.centre = { lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6) };
    $('gfLat').value = ui.centre.lat;
    $('gfLng').value = ui.centre.lng;
    drawPreview(pan);
    validate();
  }
  function drawPreview(pan) {
    if (!ui.miniMap || !ui.centre) return;
    const ll = [ui.centre.lat, ui.centre.lng];
    const r = radius() > 0 ? radius() : 300;
    const color = colourFor(type());
    if (!ui.marker) {
      ui.marker = L.marker(ll, {
        draggable: true,
        keyboard: true,
        title: 'Zone centre (drag to move)',
      }).addTo(ui.miniMap);
      ui.marker.on('drag', (e) => {
        const p = e.target.getLatLng();
        ui.centre = { lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) };
        $('gfLat').value = ui.centre.lat;
        $('gfLng').value = ui.centre.lng;
        if (ui.circle) ui.circle.setLatLng(p);
        validate();
      });
    } else ui.marker.setLatLng(ll);
    if (!ui.circle) {
      ui.circle = L.circle(ll, {
        radius: r,
        color,
        fillColor: color,
        fillOpacity: 0.12,
        weight: 1.5,
      }).addTo(ui.miniMap);
    } else {
      ui.circle.setLatLng(ll);
      ui.circle.setRadius(r);
      ui.circle.setStyle({ color, fillColor: color });
    }
    if (pan) ui.miniMap.fitBounds(ui.circle.getBounds(), { padding: [30, 30], maxZoom: 16 });
  }
  function clearPreview() {
    if (ui.marker) ui.miniMap.removeLayer(ui.marker);
    if (ui.circle) ui.miniMap.removeLayer(ui.circle);
    ui.marker = null;
    ui.circle = null;
    ui.centre = null;
  }

  // ------------------------------------------------------------------
  // Form state and validation
  // ------------------------------------------------------------------
  function fieldMsg(id, text, kind) {
    const el = $(id);
    el.textContent = text || '';
    el.className = 'gf-msg' + (kind ? ' gf-msg--' + kind : '');
  }
  function validate() {
    const name = $('gfName').value.trim();
    const r = radius();
    const okName = name.length > 0 && name.length <= 100;
    const okCentre = !!ui.centre;
    const okRadius = r >= MIN_R && r <= MAX_R;
    fieldMsg('gfNameMsg', name.length > 100 ? 'Keep the name under 100 characters.' : '', 'error');
    fieldMsg(
      'gfWhereMsg',
      okCentre
        ? `Centre ${ui.centre.lat.toFixed(5)}, ${ui.centre.lng.toFixed(5)}`
        : 'Click the map, pick a vehicle or paste a location to place the centre.',
      okCentre ? '' : 'hint'
    );
    if (!Number.isFinite(r)) fieldMsg('gfRadiusMsg', 'Enter a radius in metres.', 'error');
    else if (r < MIN_R) fieldMsg('gfRadiusMsg', `The smallest zone is ${MIN_R} m.`, 'error');
    else if (r > MAX_R) fieldMsg('gfRadiusMsg', 'The largest zone is 50 km.', 'error');
    else if (r < SMALL_R)
      fieldMsg(
        'gfRadiusMsg',
        'Small zones can flicker as GPS positions wander 5–15 m. 100 m or more is steadier.',
        'warn'
      );
    else fieldMsg('gfRadiusMsg', '', '');
    document
      .querySelectorAll('#gfPresets button')
      .forEach((b) => b.classList.toggle('on', +b.dataset.r === r));
    $('gfRadiusSlider').value = Math.min(SLIDER_MAX_R, Math.max(MIN_R, r || MIN_R));
    $('gfRadiusLabel').textContent = Number.isFinite(r) ? fmtRadius(r) : '—';

    // Live consequence summary.
    const t = type();
    const inside = okCentre && okRadius ? vehiclesInside(ui.centre, r) : [];
    $('gfTypeHelp').textContent = TYPES[t].alert;
    $('gfInside').innerHTML = !okCentre
      ? ''
      : inside.length
        ? `<b>${inside.length} vehicle${inside.length > 1 ? 's' : ''} inside now:</b> ${inside
            .map((v) => plateBadge(v))
            .join(
              ' '
            )}<div class="gf-sub">They won&rsquo;t trigger an alert for being here when you save; only later entries and exits do.</div>`
        : '<b>No vehicles inside right now.</b>';
    const ready = okName && okCentre && okRadius;
    $('gfSave').disabled = !ready;
    $('gfSaveHint').textContent = ready
      ? ''
      : !okCentre
        ? 'Place the centre first.'
        : !okName
          ? 'Give the zone a name.'
          : 'Check the radius.';
    if (ui.circle) {
      if (okRadius) ui.circle.setRadius(r);
      ui.circle.setStyle({ color: colourFor(t), fillColor: colourFor(t) });
    }
    return ready;
  }
  function say(text, kind) {
    const el = $('gfLive');
    el.textContent = text;
    el.className = 'gf-live' + (kind ? ' gf-live--' + kind : '');
  }

  function fillVehiclePicker() {
    const sel = $('gfFromVehicle');
    const cur = sel.value;
    const vs = Array.from(state.vehicles.values())
      .filter((v) => Number.isFinite(v.lat))
      .sort((a, b) => String(a.plate || a.label).localeCompare(String(b.plate || b.label)));
    sel.innerHTML =
      '<option value="">Use a vehicle&rsquo;s current position…</option>' +
      vs
        .map(
          (v) =>
            `<option value="${escapeHtml(v.id)}">${escapeHtml((v.plate || 'No plate') + ' — ' + v.label)}</option>`
        )
        .join('');
    sel.value = cur && state.vehicles.has(cur) ? cur : '';
  }

  function startNew() {
    ui.editingId = null;
    $('gfForm').reset();
    $('gfFormTitle').textContent = 'New geofence';
    $('gfSave').textContent = 'Save geofence';
    $('gfCancel').hidden = true;
    $('gfRadius').value = 300;
    fieldMsg('gfPasteMsg', '', '');
    document.querySelector('input[name="gfType"][value="depot"]').checked = true;
    if (ui.miniMap) clearPreview();
    drawContext();
    validate();
  }
  function startEdit(gf) {
    ui.editingId = gf.id;
    $('gfFormTitle').textContent = `Edit ${gf.name}`;
    $('gfSave').textContent = 'Save changes';
    $('gfCancel').hidden = false;
    $('gfName').value = gf.name;
    $('gfRadius').value = gf.radiusM;
    $('gfPaste').value = '';
    const r = document.querySelector(`input[name="gfType"][value="${gf.type}"]`);
    if (r) r.checked = true;
    ensureMiniMap();
    drawContext();
    setCentre({ lat: gf.lat, lng: gf.lng });
    $('gfForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('gfName').focus({ preventScroll: true });
  }

  async function save(e) {
    e.preventDefault();
    if (!validate()) return;
    const body = {
      name: $('gfName').value.trim(),
      lat: ui.centre.lat,
      lng: ui.centre.lng,
      radiusM: Math.round(radius()),
      type: type(),
    };
    const editing = ui.editingId;
    $('gfSave').disabled = true;
    try {
      const res = await authedFetch(
        editing ? `/api/geofences/${encodeURIComponent(editing)}` : '/api/geofences',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (editing) state.geofences = state.geofences.map((g) => (g.id === data.id ? data : g));
      else state.geofences.push(data);
      ui.flashId = data.id;
      renderGeofences();
      renderGeofenceList();
      say(
        `${editing ? 'Saved changes to' : 'Added'} ${data.name}. ${TYPES[data.type].alert}`,
        'ok'
      );
      startNew();
    } catch (err) {
      say(`Couldn’t save: ${err.message}`, 'error');
      validate();
    }
  }

  // ------------------------------------------------------------------
  // List
  // ------------------------------------------------------------------
  function renderGeofenceList() {
    const list = $('geofenceList');
    if (!list) return;
    $('gfCount').textContent = state.geofences.length;
    if (!state.geofences.length) {
      list.innerHTML = `<div class="gf-empty">
        <h3>No geofences yet</h3>
        <p>Start with your depot: click the map on the right where vehicles park overnight, choose <b>Depot or yard</b> and save. You&rsquo;ll then see when each vehicle leaves and returns.</p>
      </div>`;
      return;
    }
    list.innerHTML = state.geofences
      .map((gf) => {
        const inside = vehiclesInside(gf, gf.radiusM);
        const n24 = alerts24h(gf.id);
        const confirming = ui.confirmingId === gf.id;
        return `<article class="gf-card${ui.flashId === gf.id ? ' is-flash' : ''}${ui.editingId === gf.id ? ' is-editing' : ''}" data-id="${escapeHtml(gf.id)}">
          <div class="gf-card-main">
            <div class="gf-card-title"><span class="gf-swatch gf-swatch--${escapeHtml(gf.type)}"></span>${escapeHtml(gf.name)} <span class="gf-type ${escapeHtml(gf.type)}">${escapeHtml(TYPES[gf.type] ? TYPES[gf.type].label : gf.type)}</span></div>
            <div class="meta">Radius ${fmtRadius(gf.radiusM)} · ${n24} alert${n24 === 1 ? '' : 's'} in 24 h · ${
              inside.length ? `${inside.length} inside now` : 'none inside now'
            }</div>
            ${inside.length ? `<div class="gf-plates">${inside.map((v) => plateBadge(v)).join(' ')}</div>` : ''}
          </div>
          <div class="gf-card-actions">${
            confirming
              ? `<span class="gf-confirm">Remove ${escapeHtml(gf.name)}? Alerts already raised stay in the history.</span>
                 <button type="button" class="gf-btn gf-btn--danger" data-act="remove-yes">Remove</button>
                 <button type="button" class="gf-btn" data-act="remove-no">Keep</button>`
              : `<button type="button" class="gf-btn" data-act="show">Show on map</button>
                 <button type="button" class="gf-btn" data-act="edit">Edit</button>
                 <button type="button" class="gf-btn gf-btn--quiet" data-act="remove">Remove</button>`
          }</div>
        </article>`;
      })
      .join('');
    ui.flashId = null;
  }
  window.renderGeofenceList = renderGeofenceList;

  async function onListClick(e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('.gf-card').dataset.id;
    const gf = state.geofences.find((g) => g.id === id);
    if (!gf) return;
    const act = b.dataset.act;
    if (act === 'show') {
      document.querySelector('.tab-btn[data-tab="map"]').click();
      setTimeout(() => {
        const layer = state.geofenceLayers.get(gf.id);
        if (layer) {
          map.fitBounds(layer.getBounds(), { padding: [60, 60], maxZoom: 16 });
          layer.openTooltip();
        }
      }, 120);
    } else if (act === 'edit') {
      startEdit(gf);
      renderGeofenceList();
    } else if (act === 'remove') {
      ui.confirmingId = gf.id;
      renderGeofenceList();
      const yes = document.querySelector(
        `.gf-card[data-id="${CSS.escape(gf.id)}"] [data-act="remove-yes"]`
      );
      if (yes) yes.focus();
    } else if (act === 'remove-no') {
      ui.confirmingId = null;
      renderGeofenceList();
    } else if (act === 'remove-yes') {
      try {
        const res = await authedFetch(`/api/geofences/${encodeURIComponent(gf.id)}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        state.geofences = state.geofences.filter((g) => g.id !== gf.id);
        ui.confirmingId = null;
        if (ui.editingId === gf.id) startNew();
        renderGeofences();
        renderGeofenceList();
        drawContext();
        say(`Removed ${gf.name}.`, 'ok');
      } catch (err) {
        say(`Couldn’t remove ${gf.name}: ${err.message}`, 'error');
      }
    }
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function init() {
    if (!$('gfForm')) return;
    $('gfPresets').innerHTML = PRESETS.map(
      ([r, label]) =>
        `<button type="button" data-r="${r}">${label} <span>${fmtRadius(r)}</span></button>`
    ).join('');
    $('gfTypes').innerHTML = Object.keys(TYPES)
      .map(
        (
          k
        ) => `<label class="gf-type-opt"><input type="radio" name="gfType" value="${k}"${k === 'depot' ? ' checked' : ''} />
          <span class="gf-swatch gf-swatch--${k}"></span><span>${TYPES[k].label}</span></label>`
      )
      .join('');
    $('gfForm').addEventListener('submit', save);
    $('gfForm').addEventListener('input', (e) => {
      if (e.target.id === 'gfRadiusSlider') $('gfRadius').value = e.target.value;
      if (e.target.id === 'gfLat' || e.target.id === 'gfLng') {
        const lat = parseFloat($('gfLat').value);
        const lng = parseFloat($('gfLng').value);
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          ui.centre = { lat, lng };
          drawPreview(true);
        }
      }
      validate();
    });
    $('gfForm').addEventListener('change', (e) => {
      if (e.target.name === 'gfType') validate();
    });
    $('gfPresets').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-r]');
      if (!b) return;
      $('gfRadius').value = b.dataset.r;
      validate();
      if (ui.circle)
        ui.miniMap.fitBounds(ui.circle.getBounds(), { padding: [30, 30], maxZoom: 16 });
    });
    $('gfFromVehicle').addEventListener('change', (e) => {
      const v = state.vehicles.get(e.target.value);
      if (!v) return;
      setCentre({ lat: v.lat, lng: v.lng });
      if (!$('gfName').value.trim()) $('gfName').value = `${v.plate || v.label} location`;
      validate();
      say(`Centre set to where ${v.plate || v.label} is now.`);
      e.target.value = '';
    });
    $('gfPasteBtn').addEventListener('click', () => {
      const c = parseLocation($('gfPaste').value);
      if (!c) {
        fieldMsg(
          'gfPasteMsg',
          'Couldn’t read that. Paste "-37.8136, 144.9631" or a Google Maps link.',
          'error'
        );
        return;
      }
      fieldMsg('gfPasteMsg', '', '');
      setCentre(c);
      say('Centre placed from the pasted location.');
    });
    $('gfPaste').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('gfPasteBtn').click();
      }
    });
    $('gfCancel').addEventListener('click', () => {
      startNew();
      renderGeofenceList();
    });
    $('geofenceList').addEventListener('click', onListClick);
    startNew();
  }

  window.loadGeofencing = function () {
    ensureMiniMap();
    fillVehiclePicker();
    drawContext();
    renderGeofenceList();
    validate();
  };

  init();
})();
