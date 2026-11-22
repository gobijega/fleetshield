// Evidence record page: fetches /api/evidence-pack and lays it out as a
// one-page document to print or save as PDF. External file because the CSP
// blocks inline scripts.
(function () {
  const $ = (id) => document.getElementById(id);
  const sheet = $('epSheet');
  const params = new URLSearchParams(location.search);
  const MAX_FINDINGS = 4;

  function esc(s) {
    return String(s == null ? '' : s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }
  async function get(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 401) {
      location.href = '/login.html';
      throw new Error('signed out');
    }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Could not load the record.');
    return body;
  }

  let tz = 'Australia/Melbourne';
  const fmtDate = (iso) =>
    new Date(iso + 'T12:00:00Z').toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const fmtTime = (iso) =>
    new Date(iso).toLocaleString('en-AU', {
      timeZone: tz,
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  const fmtStamp = (iso) =>
    new Date(iso).toLocaleString('en-AU', {
      timeZone: tz,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  const plate = (p, fallback) =>
    p ? `<span class="ep-plate">${esc(p)}</span>` : esc(fallback || '—');
  const num = (n) => Number(n).toLocaleString('en-AU');
  const RESULT = { passed: 'Passed', findings: 'Findings', no_data: 'No data' };

  function render(p) {
    tz = p.period.timeZone || tz;
    const single = p.vehicles.length === 1;
    const scope = single
      ? `${p.vehicles[0].plate ? esc(p.vehicles[0].plate) + ' · ' : ''}${esc(p.vehicles[0].label)}`
      : `Whole fleet (${p.totals.vehicles} vehicles)`;
    const periodText =
      p.period.from === p.period.to
        ? fmtDate(p.period.from)
        : `${fmtDate(p.period.from)} – ${fmtDate(p.period.to)}`;

    const t = p.totals;
    const banner =
      p.overall === 'passed'
        ? `<div class="ep-result ep-result--passed"><b>No findings.</b><span>All ${p.checks.length} checks passed across ${num(t.records)} position records from ${t.vehicles} ${t.vehicles === 1 ? 'vehicle' : 'vehicles'}.</span></div>`
        : `<div class="ep-result ep-result--findings"><b>Findings to review.</b><span>${num(t.findings)} ${t.findings === 1 ? 'finding' : 'findings'} across ${t.vehiclesWithFindings} of ${t.vehicles} ${t.vehicles === 1 ? 'vehicle' : 'vehicles'}${t.vehiclesWithoutData ? `; ${t.vehiclesWithoutData} with no position data in the period` : ''}. ${num(t.records)} position records checked.</span></div>`;

    const checks = p.checks
      .map(
        (
          c
        ) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.tests)}</td><td>${esc(c.threshold)}</td>
        <td class="num"><span class="ep-pill ep-pill--${c.result}">${c.result === 'passed' ? 'Passed' : `${num(c.findings)} found`}</span>${c.result === 'passed' ? '' : `<br><span class="ep-more">${c.vehiclesAffected} ${c.vehiclesAffected === 1 ? 'vehicle' : 'vehicles'}</span>`}</td></tr>`
      )
      .join('');

    const vehicles = p.vehicles
      .map(
        (
          v
        ) => `<tr><td>${plate(v.plate, v.id)}</td><td>${esc(v.label)}</td><td class="num">${num(v.records)}${v.truncated ? '*' : ''}</td>
        <td class="num">${v.findings ? num(v.findings) + (v.high ? ` <span class="ep-sev-high">(${v.high} high)</span>` : '') : '0'}</td>
        <td><span class="ep-pill ep-pill--${v.result}">${RESULT[v.result]}</span></td>
        <td class="mono">${esc(v.chainHead.slice(0, 16))}…</td></tr>`
      )
      .join('');

    const limit = single ? MAX_FINDINGS + 6 : MAX_FINDINGS;
    const shown = p.findings.slice(0, limit);
    const findings = shown.length
      ? `<table><thead><tr><th>When (${esc(tz)})</th><th>Vehicle</th><th>Check</th><th>Severity</th><th>Why it was flagged</th></tr></thead><tbody>${shown
          .map(
            (
              f
            ) => `<tr><td class="nowrap">${esc(fmtTime(f.ts))}</td><td>${plate(f.plate, f.vehicleId)}</td><td>${esc(f.check)}</td>
            <td class="${f.severity === 'high' ? 'ep-sev-high' : ''}">${esc(f.severity.charAt(0).toUpperCase() + f.severity.slice(1))}</td><td>${esc(f.detail)}</td></tr>`
          )
          .join('')}</tbody></table>${
          p.findings.length > limit
            ? `<p class="ep-more">${num(p.findings.length - limit)} more ${p.findings.length - limit === 1 ? 'finding' : 'findings'} not shown. The full list is in the audit log export for this period.</p>`
            : ''
        }`
      : '<p class="ep-note">None in this period.</p>';

    const heads = single
      ? `<p class="ep-note">Position records chain head (SHA-256):</p><p class="ep-fp mono">${esc(p.vehicles[0].chainHead)}</p>`
      : '<p class="ep-note">Each vehicle’s chain head (first 16 characters shown above) identifies exactly which position records were checked.</p>';

    sheet.innerHTML = `
      <header class="ep-head">
        <div>
          <div class="ep-brand"><b>Fleet Shield</b> · JEGASEC</div>
          <h1 class="ep-title">Fleet data evidence record</h1>
        </div>
        <div class="ep-ref">Reference<br><span class="mono">${esc(p.reference)}</span><br><span class="ep-draft">Draft format</span></div>
      </header>
      <dl class="ep-meta">
        <div><dt>Organisation</dt><dd>${esc(p.org.name)}</dd></div>
        <div><dt>Vehicles</dt><dd>${scope}</dd></div>
        <div><dt>Period</dt><dd>${periodText} <span class="ep-more">(${esc(tz)})</span></dd></div>
        <div><dt>Generated</dt><dd>${esc(fmtStamp(p.generatedAt))}${p.generatedBy ? ` by ${esc(p.generatedBy)}` : ''}</dd></div>
        <div><dt>Data source</dt><dd>${esc(p.dataSource)}</dd></div>
        <div><dt>Position records checked</dt><dd>${num(t.records)}</dd></div>
      </dl>
      ${banner}
      <h2 class="ep-h">Checks</h2>
      <table><thead><tr><th class="w-check">Check</th><th>What it tests</th><th class="w-when">Flagged when</th><th class="num w-res">Result</th></tr></thead><tbody>${checks}</tbody></table>
      <h2 class="ep-h">${single ? 'Vehicle' : 'Vehicles'}</h2>
      <table><thead><tr><th>Plate</th><th>Vehicle</th><th class="num">Records</th><th class="num">Findings</th><th>Result</th><th>Chain head</th></tr></thead><tbody>${vehicles}</tbody></table>
      ${p.vehicles.some((v) => v.truncated) ? '<p class="ep-more">* Only the first 200,000 records were checked for this vehicle.</p>' : ''}
      <h2 class="ep-h">Findings</h2>
      ${findings}
      <div class="ep-two">
        <div>
          <h2 class="ep-h">How to verify this record</h2>
          <p class="ep-note">This record’s fingerprint (SHA-256) was written to the organisation’s audit log when it was generated:</p>
          <p class="ep-fp mono">${esc(p.fingerprint)}</p>
          ${heads}
        </div>
        <div>
          <h2 class="ep-h">What this does and does not show</h2>
          <p class="ep-note">The checks use only what each tracking device reported: position fixes, ignition, power state and odometer. A finding means the data needs review; it is not by itself proof of wrongdoing or of a fault.</p>
          <p class="ep-note">A passed check means nothing in the reported data tripped that check in this period. It does not prove the data is complete or accurate in every respect.</p>
          ${p.simulated ? '<p class="ep-note"><b>Demonstration data:</b> these vehicles are simulated and some faults are injected so the checks can be seen working.</p>' : ''}
          <p class="ep-note ep-print-only"><b>Draft format:</b> the layout and wording of this record are being confirmed with insurers and auditors. Generated by Fleet Shield, JEGASEC Pty Ltd.</p>
        </div>
      </div>
      <div class="ep-sign">
        <div>Reviewed by (name)</div><div>Role</div><div>Date</div><div>Signature</div>
      </div>
      <footer class="ep-foot">
        <span>Draft format: the layout and wording of this record are being confirmed with insurers and auditors.</span>
        <span>Generated by Fleet Shield · JEGASEC Pty Ltd</span>
      </footer>`;
    document.title = `${p.reference} · Evidence record · Fleet Shield`;
  }

  async function load() {
    $('epMsg').textContent = '';
    const q = new URLSearchParams();
    if ($('epVehicle').value) q.set('vehicle', $('epVehicle').value);
    if ($('epFrom').value) q.set('from', $('epFrom').value);
    if ($('epTo').value) q.set('to', $('epTo').value);
    window.history.replaceState(null, '', `?${q}`);
    sheet.innerHTML = '<p class="ep-loading">Preparing the record…</p>';
    try {
      const p = await get(`/api/evidence-pack?${q}`);
      if (!$('epFrom').value) $('epFrom').value = p.period.from;
      if (!$('epTo').value) $('epTo').value = p.period.to;
      render(p);
    } catch (err) {
      sheet.innerHTML = `<p class="ep-error">${esc(err.message)}</p>`;
      $('epMsg').textContent = err.message;
    }
  }

  async function init() {
    if (params.get('from')) $('epFrom').value = params.get('from');
    if (params.get('to')) $('epTo').value = params.get('to');
    try {
      const a = await get('/api/assurance');
      tz = (a.settings && a.settings.timeZone) || tz;
      const sel = $('epVehicle');
      for (const v of a.vehicles) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = `${v.plate ? v.plate + ' · ' : ''}${v.label}`;
        sel.appendChild(o);
      }
      if (params.get('vehicle')) sel.value = params.get('vehicle');
    } catch {
      /* the record still loads for the whole fleet */
    }
    load();
  }

  $('epForm').addEventListener('submit', (e) => {
    e.preventDefault();
    load();
  });
  $('epPrint').addEventListener('click', () => window.print());
  init();
})();
