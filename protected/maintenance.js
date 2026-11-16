// Fleet Shield: Compliance & Maintenance tab.
//
// Loaded after app.js and shares its globals (state, escapeHtml, plateBadge;
// authedFetch is declared as a global in eslint.config.js). Four views:
//
//   Overview      fleet maintenance board: KPIs, and per vehicle the next
//                 PM item, open work orders, out-of-service status, last
//                 inspection, registration and safety score
//   Work orders   list + drawer: status, priority, assignee, due date,
//                 checklist, parts/labour costs, out of service, comments
//                 and an activity log
//   Preventive    schedules by distance (telematics odometer) and/or time,
//   maintenance   raise a work order now, pause/resume, add schedules
//   Inspections   pre-start checklist; failures raise a corrective work order
/* global state, escapeHtml, plateBadge */

(function () {
  'use strict';
  const tab = document.getElementById('tab-compliance');
  if (!tab) return;
  const $ = (id) => document.getElementById(id);

  const ui = {
    view: 'overview',
    woStatus: 'open',
    woVehicle: 'all',
    woType: 'all',
    woSearch: '',
    openWo: null,
    template: null,
  };
  let overview = null;
  let compliance = [];
  let workOrders = [];
  let schedules = [];
  let inspections = [];

  const STATUS_LABEL = {
    open: 'Open',
    in_progress: 'In progress',
    on_hold: 'On hold',
    done: 'Done',
    cancelled: 'Cancelled',
  };
  const TYPE_LABEL = {
    preventive: 'Preventive',
    corrective: 'Corrective',
    inspection: 'Inspection',
    other: 'Other',
  };
  const PRIORITIES = ['low', 'medium', 'high', 'critical'];
  const money = (n) =>
    `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const km = (n) => (n == null ? '—' : `${Math.round(n).toLocaleString('en-AU')} km`);
  const fmtDate = (d) =>
    d
      ? new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';
  const today = () => new Date().toISOString().slice(0, 10);

  function vehicleCell(id, fallback) {
    const v = id ? state.vehicles.get(id) : null;
    if (v) return `${plateBadge(v)} <span class="vp-muted">${escapeHtml(v.label)}</span>`;
    return escapeHtml(fallback || '—');
  }
  function sevFor(status) {
    return status === 'overdue' ? 'high' : status === 'due_soon' ? 'medium' : 'good';
  }
  function dueText(d) {
    if (!d) return '—';
    const parts = [];
    if (d.kmRemaining != null)
      parts.push(d.kmRemaining < 0 ? `${km(-d.kmRemaining)} over` : `in ${km(d.kmRemaining)}`);
    if (d.daysRemaining != null)
      parts.push(d.daysRemaining < 0 ? `${-d.daysRemaining} d over` : `in ${d.daysRemaining} d`);
    return parts.join(' · ');
  }
  function live(msg) {
    $('mtLive').textContent = msg;
    clearTimeout(live.t);
    live.t = setTimeout(() => ($('mtLive').textContent = ''), 4000);
  }
  async function api(url, opts) {
    const res = await authedFetch(url, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }
  const json = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // ---------------------------------------------------------------- views
  function setView(view) {
    ui.view = view;
    tab.querySelectorAll('.mt-subnav button').forEach((b) => {
      const on = b.dataset.mt === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    tab.querySelectorAll('.mt-view').forEach((v) => (v.hidden = v.dataset.view !== view));
    refresh();
  }
  tab.querySelector('.mt-subnav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mt]');
    if (b) setView(b.dataset.mt);
  });

  async function refresh() {
    try {
      if (ui.view === 'overview') {
        [overview, compliance] = await Promise.all([
          api('/api/maintenance/overview'),
          api('/api/compliance'),
        ]);
        renderOverview();
      } else if (ui.view === 'workorders') {
        await loadWorkOrders();
      } else if (ui.view === 'pm') {
        schedules = await api('/api/maintenance/schedules');
        renderSchedules();
      } else if (ui.view === 'inspections') {
        if (!ui.template) ui.template = (await api('/api/inspections/template')).items;
        inspections = await api('/api/inspections?limit=50');
        renderInspections();
      }
      updateWoBadge();
    } catch (err) {
      live(err.message);
    }
  }
  async function updateWoBadge() {
    try {
      const open =
        ui.view === 'workorders' && ui.woStatus === 'open'
          ? workOrders
          : await api('/api/work-orders?status=open');
      $('mtWoCount').textContent = open.length;
    } catch {
      /* badge is best-effort */
    }
  }

  function vehicleOptions(sel, withAll) {
    const cur = sel.value;
    sel.innerHTML =
      (withAll ? '<option value="all">All vehicles</option>' : '') +
      Array.from(state.vehicles.values())
        .sort((a, b) => String(a.plate || a.label).localeCompare(String(b.plate || b.label)))
        .map(
          (v) =>
            `<option value="${escapeHtml(v.id)}">${escapeHtml(v.plate || v.label)} · ${escapeHtml(v.label)}</option>`
        )
        .join('');
    if (cur && Array.from(sel.options).some((o) => o.value === cur)) sel.value = cur;
  }

  // -------------------------------------------------------------- overview
  function renderOverview() {
    const k = overview.kpis;
    const card = (v, l, cls = '') =>
      `<div class="al-card ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    $('mtKpis').innerHTML =
      card(k.outOfService, 'Vehicles out of service', k.outOfService ? 'al-card--high' : '') +
      card(k.pmOverdue, 'Maintenance overdue', k.pmOverdue ? 'al-card--high' : '') +
      card(k.pmDueSoon, 'Maintenance due soon', k.pmDueSoon ? 'al-card--open' : '') +
      card(k.openWorkOrders, 'Open work orders') +
      card(
        k.overdueWorkOrders,
        'Work orders past due',
        k.overdueWorkOrders ? 'al-card--open' : ''
      ) +
      card(`${k.inspectedLast24h} / ${k.vehicles}`, 'Inspected in last 24 h') +
      card(money(k.cost30d), 'Maintenance cost, 30 days');
    const comp = new Map(compliance.map((c) => [c.id, c]));
    $('mtFleetRows').innerHTML = overview.vehicles
      .map((v) => {
        const c = comp.get(v.id) || {};
        const n = v.next;
        return `<tr>
          <td>${plateBadge(v)}${v.outOfService ? ' <span class="sev sev-high">out of service</span>' : ''}</td>
          <td>${escapeHtml(v.label)}<span class="mt-sub">${escapeHtml(v.driver || '')}</span></td>
          <td class="mt-num">${km(v.odometerKm)}</td>
          <td>${n ? `<span class="sev sev-${sevFor(n.status)}">${n.status.replace('_', ' ')}</span> ${escapeHtml(n.name)}<span class="mt-sub">${dueText(n)}</span>` : '<span class="vp-muted">No schedules</span>'}</td>
          <td>${v.openWorkOrders ? `<button type="button" class="mt-link" data-wo-vehicle="${escapeHtml(v.id)}">${v.openWorkOrders} open</button>` : '<span class="vp-muted">None</span>'}</td>
          <td>${v.lastInspection ? `<span class="sev sev-${v.lastInspection.passed ? 'good' : 'high'}">${v.lastInspection.passed ? 'passed' : 'failed'}</span><span class="mt-sub">${fmtDate(v.lastInspection.ts)}</span>` : '<span class="vp-muted">None yet</span>'}</td>
          <td>${c.regoStatus ? `<span class="sev sev-${sevFor(c.regoStatus)}">${c.regoStatus.replace('_', ' ')}</span><span class="mt-sub">${escapeHtml(c.regoExpiryDate)} (${c.regoDaysRemaining} d)</span>` : '—'}</td>
          <td class="mt-num">${c.safetyScore != null ? c.safetyScore : '—'}</td>
        </tr>`;
      })
      .join('');
  }
  $('mtFleetRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-wo-vehicle]');
    if (!b) return;
    ui.woVehicle = b.dataset.woVehicle;
    ui.woStatus = 'open';
    setView('workorders');
  });

  // ----------------------------------------------------------- work orders
  async function loadWorkOrders() {
    vehicleOptions($('mtWoVehicle'), true);
    $('mtWoVehicle').value = ui.woVehicle;
    $('mtWoStatus')
      .querySelectorAll('button')
      .forEach((x) => {
        x.classList.toggle('active', x.dataset.st === ui.woStatus);
        x.setAttribute('aria-pressed', String(x.dataset.st === ui.woStatus));
      });
    const q = new URLSearchParams({ status: ui.woStatus });
    if (ui.woVehicle !== 'all') q.set('vehicleId', ui.woVehicle);
    workOrders = await api(`/api/work-orders?${q}`);
    renderWorkOrders();
    if (ui.openWo) openWorkOrder(ui.openWo, { quiet: true });
  }

  function renderWorkOrders() {
    const s = ui.woSearch;
    const list = workOrders.filter((w) => {
      if (ui.woType !== 'all' && w.type !== ui.woType) return false;
      if (!s) return true;
      const v = w.vehicleId ? state.vehicles.get(w.vehicleId) : null;
      return [w.ref, w.title, w.assignee, w.vehicleLabel, v && v.plate, v && v.label]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(s);
    });
    const t = today();
    $('mtWoRows').innerHTML = list
      .map((w) => {
        const pastDue = w.dueDate && w.dueDate < t && !['done', 'cancelled'].includes(w.status);
        const done = w.checklist.filter((i) => i.done).length;
        return `<tr class="al-row mt-wo-row${ui.openWo === w.id ? ' al-row--open' : ''}" data-wo="${w.id}">
          <td class="mt-ref">${w.ref}</td>
          <td><span class="al-type">${escapeHtml(w.title)}</span><span class="mt-sub">${TYPE_LABEL[w.type]}${w.checklist.length ? ` · checklist ${done}/${w.checklist.length}` : ''}${w.outOfService ? ' · <b class="mt-oos">vehicle out of service</b>' : ''}</span></td>
          <td>${vehicleCell(w.vehicleId, w.vehicleLabel)}</td>
          <td><span class="mt-pri mt-pri--${w.priority}">${w.priority}</span></td>
          <td><span class="mt-st mt-st--${w.status}">${STATUS_LABEL[w.status]}</span></td>
          <td>${escapeHtml(w.assignee || '—')}</td>
          <td class="${pastDue ? 'mt-late' : ''}">${w.dueDate ? fmtDate(w.dueDate) : '—'}</td>
          <td class="mt-num">${w.costTotal ? money(w.costTotal) : '—'}</td>
        </tr>`;
      })
      .join('');
    $('mtWoEmpty').hidden = list.length > 0;
  }

  async function openWorkOrder(id, { quiet = false } = {}) {
    try {
      const w = await api(`/api/work-orders/${encodeURIComponent(id)}`);
      ui.openWo = id;
      renderDrawer(w);
      if (!quiet) renderWorkOrders();
    } catch (err) {
      live(err.message);
    }
  }

  function renderDrawer(w) {
    const d = $('mtWoDrawer');
    const closed = ['done', 'cancelled'].includes(w.status);
    const statusBtns = {
      open: [
        ['in_progress', 'Start work'],
        ['on_hold', 'Put on hold'],
        ['done', 'Mark done'],
        ['cancelled', 'Cancel'],
      ],
      in_progress: [
        ['done', 'Mark done'],
        ['on_hold', 'Put on hold'],
        ['open', 'Back to open'],
      ],
      on_hold: [
        ['in_progress', 'Resume'],
        ['done', 'Mark done'],
        ['cancelled', 'Cancel'],
      ],
      done: [['open', 'Reopen']],
      cancelled: [['open', 'Reopen']],
    }[w.status];
    d.innerHTML = `
      <div class="al-drawer-head">
        <div>
          <span class="mt-ref">${w.ref}</span> <span class="mt-pri mt-pri--${w.priority}">${w.priority}</span> <span class="mt-st mt-st--${w.status}">${STATUS_LABEL[w.status]}</span>
          <h3>${escapeHtml(w.title)}</h3>
          ${w.description ? `<p class="al-drawer-msg">${escapeHtml(w.description)}</p>` : ''}
        </div>
        <button type="button" class="al-close" data-close aria-label="Close work order">×</button>
      </div>
      <div class="mt-status-btns">${statusBtns
        .map(
          ([s, l]) =>
            `<button type="button" class="al-btn${s === 'done' ? ' al-btn--primary' : ''}" data-status="${s}">${l}</button>`
        )
        .join('')}</div>
      <form class="mt-wo-edit" data-edit="${w.id}">
        <div class="mt-form-grid">
          <label>Assignee <input name="assignee" maxlength="120" value="${escapeHtml(w.assignee || '')}" placeholder="Technician or workshop" ${closed ? 'disabled' : ''} /></label>
          <label>Due <input name="dueDate" type="date" value="${w.dueDate || ''}" ${closed ? 'disabled' : ''} /></label>
          <label>Priority <select name="priority" ${closed ? 'disabled' : ''}>${PRIORITIES.map((p) => `<option value="${p}"${p === w.priority ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
          <label class="mt-check"><input type="checkbox" name="outOfService" ${w.outOfService ? 'checked' : ''} ${closed ? 'disabled' : ''} /> Vehicle out of service</label>
        </div>
        ${closed ? '' : '<button type="submit" class="al-btn">Save details</button>'}
      </form>
      <dl class="al-dl">
        <div><dt>Vehicle</dt><dd>${vehicleCell(w.vehicleId, w.vehicleLabel)}</dd></div>
        <div><dt>Type</dt><dd>${TYPE_LABEL[w.type]}${w.scheduleId ? ' · from PM schedule' : ''}${w.inspectionId ? ' · from inspection' : ''}</dd></div>
        <div><dt>Created</dt><dd>${fmtDate(w.createdAt)} by ${escapeHtml(w.createdBy || '—')}</dd></div>
        ${w.completedAt ? `<div><dt>Completed</dt><dd>${fmtDate(w.completedAt)} by ${escapeHtml(w.completedBy || '—')}${w.completionOdometerKm != null ? ` at ${km(w.completionOdometerKm)}` : ''}</dd></div>` : ''}
      </dl>
      <h4>Checklist</h4>
      <ul class="mt-checklist">${
        w.checklist.length
          ? w.checklist
              .map(
                (i, n) =>
                  `<li><label><input type="checkbox" data-check="${n}" ${i.done ? 'checked' : ''} ${closed ? 'disabled' : ''} /> <span>${escapeHtml(i.text)}</span></label></li>`
              )
              .join('')
          : '<li class="hint">No checklist.</li>'
      }</ul>
      ${closed ? '' : '<form class="mt-inline" data-add-check><input name="text" maxlength="200" placeholder="Add a checklist item" aria-label="New checklist item" /><button type="submit" class="al-btn">Add</button></form>'}
      <h4>Parts and labour <span class="vp-muted">${w.costTotal ? `· ${money(w.costTotal)}` : ''}</span></h4>
      <table class="mt-costs">
        <tbody>${
          w.costs
            .map(
              (c, n) =>
                `<tr><td>${c.kind}</td><td>${escapeHtml(c.description)}</td><td class="mt-num">${money(c.amount)}</td><td>${closed ? '' : `<button type="button" class="al-ico" data-rm-cost="${n}" aria-label="Remove cost line" title="Remove">×</button>`}</td></tr>`
            )
            .join('') || '<tr><td colspan="4" class="hint">No costs recorded.</td></tr>'
        }</tbody>
      </table>
      ${
        closed
          ? ''
          : `<form class="mt-inline mt-cost-form" data-add-cost>
              <select name="kind" aria-label="Cost type"><option value="parts">Parts</option><option value="labour">Labour</option><option value="other">Other</option></select>
              <input name="description" maxlength="200" placeholder="Description" aria-label="Cost description" />
              <input name="amount" type="number" min="0" step="0.01" placeholder="$ ex GST" aria-label="Amount" required />
              <button type="submit" class="al-btn">Add</button>
            </form>`
      }
      <h4>Activity</h4>
      <ul class="al-history mt-activity">${w.events
        .map(
          (e) =>
            `<li><b>${escapeHtml(e.username || 'system')}</b> <span class="vp-muted">${new Date(e.ts).toLocaleString('en-AU')}</span><br />${e.kind === 'comment' ? `<span class="mt-comment">${escapeHtml(e.detail)}</span>` : escapeHtml(e.detail || e.kind)}</li>`
        )
        .join('')}</ul>
      <form class="mt-inline" data-comment>
        <input name="text" maxlength="2000" placeholder="Add a comment" aria-label="Comment" />
        <button type="submit" class="al-btn">Post</button>
      </form>`;
    d.hidden = false;
    d._wo = w;
  }

  async function patchWo(changes, msg) {
    const w = $('mtWoDrawer')._wo;
    try {
      await api(`/api/work-orders/${encodeURIComponent(w.id)}`, json('PATCH', changes));
      if (msg) live(msg);
      await loadWorkOrders();
      updateWoBadge();
    } catch (err) {
      live(err.message);
    }
  }

  $('mtWoDrawer').addEventListener('click', (e) => {
    const w = $('mtWoDrawer')._wo;
    if (e.target.closest('[data-close]')) {
      ui.openWo = null;
      $('mtWoDrawer').hidden = true;
      renderWorkOrders();
      return;
    }
    const s = e.target.closest('[data-status]');
    if (s)
      return patchWo({ status: s.dataset.status }, `${w.ref}: ${STATUS_LABEL[s.dataset.status]}`);
    const rm = e.target.closest('[data-rm-cost]');
    if (rm) {
      const costs = w.costs.filter((_, i) => i !== Number(rm.dataset.rmCost));
      return patchWo({ costs }, 'Cost removed');
    }
  });
  $('mtWoDrawer').addEventListener('change', (e) => {
    const c = e.target.closest('[data-check]');
    if (!c) return;
    const w = $('mtWoDrawer')._wo;
    const checklist = w.checklist.map((i, n) =>
      n === Number(c.dataset.check) ? { ...i, done: c.checked } : i
    );
    patchWo({ checklist });
  });
  $('mtWoDrawer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const w = $('mtWoDrawer')._wo;
    if (f.matches('[data-edit]')) {
      return patchWo(
        {
          assignee: f.elements.assignee.value,
          dueDate: f.elements.dueDate.value || null,
          priority: f.elements.priority.value,
          outOfService: f.elements.outOfService.checked,
        },
        'Saved'
      );
    }
    if (f.matches('[data-add-check]')) {
      const text = f.elements.text.value.trim();
      if (text) return patchWo({ checklist: [...w.checklist, { text, done: false }] });
      return;
    }
    if (f.matches('[data-add-cost]')) {
      const amount = Number(f.elements.amount.value);
      if (!Number.isFinite(amount) || amount < 0) return f.elements.amount.focus();
      return patchWo(
        {
          costs: [
            ...w.costs,
            { kind: f.elements.kind.value, description: f.elements.description.value, amount },
          ],
        },
        'Cost added'
      );
    }
    if (f.matches('[data-comment]')) {
      const text = f.elements.text.value.trim();
      if (!text) return;
      try {
        await api(`/api/work-orders/${encodeURIComponent(w.id)}/comments`, json('POST', { text }));
        openWorkOrder(w.id, { quiet: true });
      } catch (err) {
        live(err.message);
      }
    }
  });

  $('mtWoRows').addEventListener('click', (e) => {
    const r = e.target.closest('tr[data-wo]');
    if (r) openWorkOrder(r.dataset.wo);
  });
  $('mtWoStatus').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-st]');
    if (!b) return;
    ui.woStatus = b.dataset.st;
    loadWorkOrders().catch((err) => live(err.message));
  });
  $('mtWoVehicle').addEventListener('change', (e) => {
    ui.woVehicle = e.target.value;
    loadWorkOrders().catch((err) => live(err.message));
  });
  $('mtWoType').addEventListener('change', (e) => {
    ui.woType = e.target.value;
    renderWorkOrders();
  });
  $('mtWoSearch').addEventListener('input', (e) => {
    ui.woSearch = e.target.value.trim().toLowerCase();
    renderWorkOrders();
  });

  // New work order: a blank drawer form.
  $('mtNewWo').addEventListener('click', () => {
    setView('workorders');
    const d = $('mtWoDrawer');
    ui.openWo = null;
    d.innerHTML = `
      <div class="al-drawer-head"><h3>New work order</h3><button type="button" class="al-close" data-close aria-label="Close">×</button></div>
      <form class="mt-form mt-new" id="mtNewForm">
        <label>Title <input name="title" required maxlength="160" placeholder="e.g. Replace front brake pads" /></label>
        <label>Vehicle <select name="vehicleId"></select></label>
        <div class="mt-form-grid">
          <label>Type <select name="type"><option value="corrective">Corrective</option><option value="preventive">Preventive</option><option value="inspection">Inspection</option><option value="other">Other</option></select></label>
          <label>Priority <select name="priority">${PRIORITIES.map((p) => `<option value="${p}"${p === 'medium' ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
          <label>Assignee <input name="assignee" maxlength="120" /></label>
          <label>Due <input name="dueDate" type="date" /></label>
        </div>
        <label>Description <textarea name="description" rows="3" maxlength="4000"></textarea></label>
        <label>Checklist <span class="vp-muted">(one task per line)</span><textarea name="checklist" rows="3"></textarea></label>
        <label class="mt-check"><input type="checkbox" name="outOfService" /> Vehicle out of service until done</label>
        <button type="submit" class="al-btn al-btn--primary">Create work order</button>
      </form>`;
    vehicleOptions(d.querySelector('select[name=vehicleId]'), false);
    d.hidden = false;
    d._wo = null;
    d.querySelector('input[name=title]').focus();
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'mtNewForm') return;
    e.preventDefault();
    const f = e.target;
    try {
      const w = await api(
        '/api/work-orders',
        json('POST', {
          title: f.elements.title.value,
          vehicleId: f.elements.vehicleId.value,
          type: f.elements.type.value,
          priority: f.elements.priority.value,
          assignee: f.elements.assignee.value,
          dueDate: f.elements.dueDate.value || null,
          description: f.elements.description.value,
          checklist: f.elements.checklist.value
            .split('\n')
            .map((t) => t.trim())
            .filter(Boolean),
          outOfService: f.elements.outOfService.checked,
        })
      );
      live(`${w.ref} created`);
      ui.woStatus = 'open';
      ui.openWo = w.id;
      await loadWorkOrders();
      updateWoBadge();
    } catch (err) {
      live(err.message);
    }
  });

  // ------------------------------------------------------------ schedules
  function renderSchedules() {
    vehicleOptions($('mtPmForm').elements.vehicleId, false);
    const rank = { overdue: 0, due_soon: 1, ok: 2 };
    const list = schedules.slice().sort((a, b) => {
      const va = state.vehicles.get(a.vehicleId);
      const vb = state.vehicles.get(b.vehicleId);
      return (
        (a.active === b.active ? 0 : a.active ? -1 : 1) ||
        rank[a.due ? a.due.status : 'ok'] - rank[b.due ? b.due.status : 'ok'] ||
        String(va ? va.plate || va.label : '').localeCompare(
          String(vb ? vb.plate || vb.label : '')
        ) ||
        a.name.localeCompare(b.name)
      );
    });
    $('mtPmRows').innerHTML = list
      .map((s) => {
        const interval = [
          s.intervalKm ? km(s.intervalKm) : null,
          s.intervalDays ? `${s.intervalDays} days` : null,
        ]
          .filter(Boolean)
          .join(' or ');
        const last = [
          s.lastDoneKm != null ? km(s.lastDoneKm) : null,
          s.lastDoneAt ? fmtDate(s.lastDoneAt) : null,
        ]
          .filter(Boolean)
          .join(' · ');
        const next = s.due
          ? [
              s.due.dueKm != null ? km(s.due.dueKm) : null,
              s.due.dueAt ? fmtDate(s.due.dueAt) : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : '—';
        const st = !s.active
          ? '<span class="vp-muted">Paused</span>'
          : s.due
            ? `<span class="sev sev-${sevFor(s.due.status)}">${s.due.status.replace('_', ' ')}</span><span class="mt-sub">${dueText(s.due)}</span>`
            : '—';
        const act = s.openWorkOrderId
          ? `<button type="button" class="mt-link" data-goto-wo="${s.openWorkOrderId}">Open work order</button>`
          : s.active
            ? `<button type="button" class="al-btn al-btn--sm" data-raise="${s.id}">Raise work order</button>`
            : '';
        return `<tr class="${s.active ? '' : 'mt-paused'}">
          <td>${vehicleCell(s.vehicleId)}</td>
          <td>${escapeHtml(s.name)}${s.checklist.length ? `<span class="mt-sub">${s.checklist.length} tasks</span>` : ''}</td>
          <td>${interval}</td>
          <td>${last || '—'}</td>
          <td>${next}</td>
          <td>${st}</td>
          <td class="mt-actions">${act}<button type="button" class="mt-link" data-toggle="${s.id}" data-active="${s.active}">${s.active ? 'Pause' : 'Resume'}</button></td>
        </tr>`;
      })
      .join('');
  }
  $('mtPmRows').addEventListener('click', async (e) => {
    const r = e.target.closest('[data-raise]');
    const g = e.target.closest('[data-goto-wo]');
    const t = e.target.closest('[data-toggle]');
    try {
      if (r) {
        const w = await api(
          `/api/maintenance/schedules/${encodeURIComponent(r.dataset.raise)}/raise`,
          { method: 'POST' }
        );
        live(`${w.ref} raised`);
        refresh();
      } else if (g) {
        ui.woStatus = 'open';
        ui.woVehicle = 'all';
        ui.openWo = g.dataset.gotoWo;
        setView('workorders');
      } else if (t) {
        await api(
          `/api/maintenance/schedules/${encodeURIComponent(t.dataset.toggle)}`,
          json('PATCH', { active: t.dataset.active !== 'true' })
        );
        refresh();
      }
    } catch (err) {
      live(err.message);
    }
  });
  $('mtPmForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(
        '/api/maintenance/schedules',
        json('POST', {
          vehicleId: f.elements.vehicleId.value,
          name: f.elements.name.value,
          intervalKm: f.elements.intervalKm.value || null,
          intervalDays: f.elements.intervalDays.value || null,
          checklist: f.elements.checklist.value
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
        })
      );
      f.reset();
      live('Schedule added');
      refresh();
    } catch (err) {
      live(err.message);
    }
  });

  // ----------------------------------------------------------- inspections
  function renderInspections() {
    const form = $('mtInspForm');
    vehicleOptions(form.elements.vehicleId, false);
    const items = $('mtInspItems');
    if (!items.dataset.ready) {
      items.innerHTML = ui.template
        .map(
          (item, n) => `<fieldset class="mt-insp-item">
            <legend>${escapeHtml(item)}</legend>
            ${['pass', 'fail', 'na']
              .map(
                (r) =>
                  `<label class="mt-pill mt-pill--${r}"><input type="radio" name="r${n}" value="${r}" ${r === 'pass' ? 'checked' : ''} /> ${r === 'na' ? 'N/A' : r[0].toUpperCase() + r.slice(1)}</label>`
              )
              .join('')}
            <input class="mt-insp-note" name="n${n}" maxlength="300" placeholder="What's wrong?" aria-label="Note for ${escapeHtml(item)}" hidden />
          </fieldset>`
        )
        .join('');
      items.dataset.ready = '1';
    }
    $('mtInspRows').innerHTML =
      inspections
        .map((i) => {
          const failed = (i.results || []).filter((r) => r.result === 'fail');
          return `<tr>
            <td>${new Date(i.ts).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td>${vehicleCell(i.vehicleId, i.vehicleLabel)}</td>
            <td>${escapeHtml(i.inspector)}</td>
            <td><span class="sev sev-${i.passed ? 'good' : 'high'}">${i.passed ? 'passed' : `failed ${failed.length}`}</span>${failed.length ? `<span class="mt-sub">${escapeHtml(failed.map((f) => f.item).join(', '))}</span>` : ''}</td>
            <td class="mt-num">${km(i.odometerKm)}</td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="5" class="hint">No inspections yet.</td></tr>';
  }
  $('mtInspItems').addEventListener('change', (e) => {
    const fs = e.target.closest('.mt-insp-item');
    if (!fs || e.target.type !== 'radio') return;
    const note = fs.querySelector('.mt-insp-note');
    note.hidden = e.target.value !== 'fail';
    fs.classList.toggle('is-fail', e.target.value === 'fail');
    if (!note.hidden) note.focus();
  });
  $('mtInspForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const results = ui.template.map((item, n) => ({
      item,
      result: f.querySelector(`input[name="r${n}"]:checked`).value,
      note: f.elements[`n${n}`].value,
    }));
    try {
      const out = await api(
        '/api/inspections',
        json('POST', {
          vehicleId: f.elements.vehicleId.value,
          inspector: f.elements.inspector.value,
          notes: f.elements.notes.value,
          results,
        })
      );
      live(
        out.workOrder
          ? `Inspection recorded. ${out.workOrder.ref} raised for the failed items.`
          : 'Inspection recorded: all passed.'
      );
      const keepInspector = f.elements.inspector.value;
      f.reset();
      f.elements.inspector.value = keepInspector;
      f.querySelectorAll('.mt-insp-item').forEach((x) => {
        x.classList.remove('is-fail');
        x.querySelector('.mt-insp-note').hidden = true;
      });
      refresh();
    } catch (err) {
      live(err.message);
    }
  });

  window.loadMaintenance = refresh;
})();
