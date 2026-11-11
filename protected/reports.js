// Fleet Shield — Reports tab.
//
// Renders GET /api/reports/fleet: a period-based fleet report compared
// with the period before it — KPI tiles with change and trend, generated
// findings, daily trends, safety breakdowns, an event heatmap, a sortable
// vehicle league table with a per-vehicle drill-down, CSV export and a
// print/PDF layout. All derivation happens server-side (lib/reports.js);
// this file only presents it.
//
// Vehicle labels and driver names are customer-entered, so every piece of
// data reaches the DOM through textContent / escapeHtml, never raw.
//
// Depends on globals from app.js (authedFetch) and vendor/chart.umd.js.

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Palette — validated with the dataviz palette checker against the
  // panel surface (#0e131c): the three fuel / series hues pass every
  // categorical check all-pairs in dark mode. Severity uses the status
  // colours and is always shown with a legend and labels, never colour
  // alone. A light set is swapped in for printing.
  // ---------------------------------------------------------------------
  const THEMES = {
    screen: {
      text: '#e6ebf3',
      muted: '#8a97ab',
      grid: '#1a2230',
      surface: '#0e131c',
      series: '#3987e5',
      moving: '#3987e5',
      idle: '#d95926',
      fuel: { diesel: '#3987e5', petrol: '#d95926', ev: '#199e70' },
      sev: { high: '#e34948', medium: '#eda100', low: '#3987e5', info: '#5b6577' },
      heat: ['#104281', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#b7d3f6'],
    },
    print: {
      text: '#0b0b0b',
      muted: '#52514e',
      grid: '#e4e4e0',
      surface: '#ffffff',
      series: '#2a78d6',
      moving: '#2a78d6',
      idle: '#eb6834',
      fuel: { diesel: '#2a78d6', petrol: '#eb6834', ev: '#1baf7a' },
      sev: { high: '#e34948', medium: '#eda100', low: '#2a78d6', info: '#9a9a94' },
      heat: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'],
    },
  };
  let theme = THEMES.screen;

  const SEVERITIES = ['high', 'medium', 'low', 'info'];
  const SEV_LABEL = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
  const FUEL_LABEL = { diesel: 'Diesel', petrol: 'Petrol', ev: 'EV' };
  const STORE_KEY = 'fs.reports.v1';

  const state = {
    query: { preset: '14d', from: null, to: null, fuel: 'all' },
    report: null,
    sort: { key: 'distanceKm', dir: 'desc' },
    search: '',
    charts: {},
    drawerChart: null,
    drawerVehicleId: null,
    orgName: null,
    inflight: 0,
    bound: false,
  };

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  const nf = (dp = 0) =>
    new Intl.NumberFormat('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  function num(value, dp = 0) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return nf(dp).format(value);
  }
  function compact(value) {
    if (value === null || value === undefined) return '—';
    if (Math.abs(value) >= 100000) return `${nf(0).format(value / 1000)}k`;
    if (Math.abs(value) >= 10000) return `${nf(1).format(value / 1000)}k`;
    return nf(0).format(value);
  }

  function parseDay(day) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const fmtDay = (day, opts = { day: 'numeric', month: 'short' }) =>
    parseDay(day).toLocaleDateString('en-AU', opts);
  function fmtRange(from, to) {
    if (from === to)
      return fmtDay(from, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const a = parseDay(from);
    const b = parseDay(to);
    if (a.getFullYear() === b.getFullYear()) {
      if (a.getMonth() === b.getMonth())
        return `${a.getDate()}–${fmtDay(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
      return `${fmtDay(from)} – ${fmtDay(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    return `${fmtDay(from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDay(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  const humanType = (t) => t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

  function loadPrefs() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        if (saved.query) Object.assign(state.query, saved.query);
        if (saved.sort) state.sort = saved.sort;
      }
    } catch {
      /* storage unavailable — defaults are fine */
    }
  }
  function savePrefs() {
    try {
      window.localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ query: state.query, sort: state.sort })
      );
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------
  function queryString() {
    const q = state.query;
    const params = new URLSearchParams();
    if (q.preset === 'custom' && q.from && q.to) {
      params.set('from', q.from);
      params.set('to', q.to);
    } else {
      params.set('preset', q.preset === 'custom' ? '14d' : q.preset);
    }
    if (q.fuel && q.fuel !== 'all') params.set('fuel', q.fuel);
    return params.toString();
  }

  async function fetchReport() {
    const ticket = ++state.inflight;
    const body = $('rpBody');
    body.classList.add('is-loading');
    body.setAttribute('aria-busy', 'true');
    $('rpError').hidden = true;
    try {
      const res = await authedFetch(`/api/reports/fleet?${queryString()}`);
      const data = await res.json().catch(() => ({}));
      if (ticket !== state.inflight) return; // a newer request superseded this one
      if (!res.ok) throw new Error(data.error || 'The report could not be generated.');
      state.report = data;
      render();
    } catch (err) {
      if (ticket !== state.inflight || err.message === 'unauthenticated') return;
      const el = $('rpError');
      el.textContent = err.message || 'The report could not be generated.';
      el.hidden = false;
    } finally {
      if (ticket === state.inflight) {
        body.classList.remove('is-loading');
        body.removeAttribute('aria-busy');
      }
    }
  }

  // ---------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------
  function syncToolbar() {
    const q = state.query;
    document.querySelectorAll('#rpPresets button').forEach((b) => {
      const on = b.dataset.preset === q.preset;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $('rpCustomForm').hidden = q.preset !== 'custom';
    $('rpFuel').value = q.fuel || 'all';
    if (state.report) {
      const today = new Date().toLocaleDateString('en-CA');
      $('rpFrom').max = today;
      $('rpTo').max = today;
      if (!$('rpFrom').value) $('rpFrom').value = state.report.period.from;
      if (!$('rpTo').value) $('rpTo').value = state.report.period.to;
    }
  }

  function bindToolbar() {
    $('rpPresets').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-preset]');
      if (!btn) return;
      state.query.preset = btn.dataset.preset;
      syncToolbar();
      if (btn.dataset.preset === 'custom') {
        $('rpFrom').focus();
        return; // wait for Apply
      }
      savePrefs();
      fetchReport();
    });

    $('rpCustomForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const from = $('rpFrom').value;
      const to = $('rpTo').value;
      const err = $('rpError');
      if (!from || !to || from > to) {
        err.textContent = 'Choose a start date on or before the end date.';
        err.hidden = false;
        return;
      }
      state.query.from = from;
      state.query.to = to;
      savePrefs();
      fetchReport();
    });

    $('rpFuel').addEventListener('change', (e) => {
      state.query.fuel = e.target.value;
      savePrefs();
      fetchReport();
    });

    $('rpExportVehicles').addEventListener('click', () => exportCsv('vehicles'));
    $('rpExportDaily').addEventListener('click', () => exportCsv('daily'));
    $('rpPrint').addEventListener('click', () => window.print());

    $('rpSearch').addEventListener('input', (e) => {
      state.search = e.target.value.trim().toLowerCase();
      renderTable();
    });

    $('rpTable')
      .querySelector('thead')
      .addEventListener('click', (e) => {
        const th = e.target.closest('th[data-sort]');
        if (!th) return;
        const key = th.dataset.sort;
        if (state.sort.key === key) {
          state.sort = { key, dir: state.sort.dir === 'desc' ? 'asc' : 'desc' };
        } else {
          state.sort = { key, dir: key === 'label' ? 'asc' : 'desc' };
        }
        savePrefs();
        renderTable();
      });

    const rows = $('rpRows');
    rows.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) openDrawer(tr.dataset.id);
    });
    rows.addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openDrawer(tr.dataset.id);
      }
    });

    $('rpFindings').addEventListener('click', (e) => {
      const chip = e.target.closest('button[data-vehicle]');
      if (chip) openDrawer(chip.dataset.vehicle);
    });

    $('rpDrawerClose').addEventListener('click', closeDrawer);
    $('rpScrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('rpDrawer').hidden) closeDrawer();
    });

    // Print in light ink: re-render charts with the print palette and put
    // the screen palette back afterwards.
    // The methodology is opened for print so the PDF carries it.
    let methodWasOpen = false;
    window.addEventListener('beforeprint', () => {
      const method = document.querySelector('.rp-method');
      methodWasOpen = method.open;
      method.open = true;
      setTheme('print');
    });
    window.addEventListener('afterprint', () => {
      document.querySelector('.rp-method').open = methodWasOpen;
      setTheme('screen');
    });
  }

  function setTheme(name) {
    if (theme === THEMES[name]) return;
    theme = THEMES[name];
    if (state.report && $('tab-reports').classList.contains('active')) {
      renderCharts();
      renderHeatmap();
      renderFuelMix();
    }
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  function render() {
    syncToolbar();
    renderHeader();
    renderKpis();
    renderFindings();
    renderCharts();
    renderHeatmap();
    renderFuelMix();
    renderTable();
    renderMethodology();
    if (state.drawerVehicleId) openDrawer(state.drawerVehicleId, { keepFocus: true });
  }

  function renderHeader() {
    const r = state.report;
    const p = r.period;
    const generated = new Date(r.generatedAt).toLocaleString('en-AU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    const scope = r.scope.fuel
      ? `${r.scope.vehicles} ${FUEL_LABEL[r.scope.fuel]} vehicle${r.scope.vehicles === 1 ? '' : 's'}`
      : `${r.scope.vehicles} vehicle${r.scope.vehicles === 1 ? '' : 's'}`;
    $('rpPeriod').textContent =
      fmtRange(p.from, p.to) +
      (p.includesToday && p.days > 1 ? ' (to date)' : p.includesToday ? ' (so far)' : '');
    const basis = p.comparisonBasis === 'elapsed' ? ' to the same time of day' : '';
    $('rpSub').textContent =
      `Compared with ${fmtRange(p.previous.from, p.previous.to)}${basis} · ${scope} · local days in ${p.timeZone} · generated ${generated}`;
    $('rpPrintOrg').textContent = state.orgName || '';

    const note = $('rpCoverage');
    if (r.historyStartsOn && r.historyStartsOn > p.previous.from) {
      const inPeriod = r.historyStartsOn > p.from;
      note.textContent = inPeriod
        ? `Telemetry history begins on ${fmtDay(r.historyStartsOn, { day: 'numeric', month: 'long', year: 'numeric' })}. Days before that show no activity, and there is no comparison period yet.`
        : `Telemetry history begins on ${fmtDay(r.historyStartsOn, { day: 'numeric', month: 'long', year: 'numeric' })}, part-way through the comparison period, so changes against the previous period are not shown.`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  // --- KPI tiles ---------------------------------------------------------
  function deltaChip(k, opts = {}) {
    if (opts.incomplete) return '<span class="rp-delta neutral">partial history</span>';
    if (!k || k.changePct === null || k.previous === null) {
      return k && k.previous === 0 && k.value > 0
        ? '<span class="rp-delta neutral">new this period</span>'
        : '<span class="rp-delta neutral">no comparison</span>';
    }
    const change = k.changePct;
    if (Math.abs(change) < 0.5)
      return '<span class="rp-delta neutral"><span aria-hidden="true">→</span> no change</span>';
    const up = change > 0;
    let tone = 'neutral';
    if (k.better === 'up') tone = up ? 'good' : 'bad';
    if (k.better === 'down') tone = up ? 'bad' : 'good';
    const arrow = up ? '▲' : '▼';
    const label = `${up ? '+' : ''}${num(change, Math.abs(change) < 10 ? 1 : 0)}%`;
    return `<span class="rp-delta ${tone}"><span aria-hidden="true">${arrow}</span> ${label}<span class="rp-delta-vs"> vs ${escapeHtml(opts.prevLabel || 'prev.')}</span></span>`;
  }

  function sparkline(values) {
    if (!values || values.length < 2) return '';
    const w = 120;
    const h = 30;
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const pts = values.map(
      (v, i) =>
        `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`
    );
    const last = pts[pts.length - 1].split(',');
    return `<svg class="rp-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="2.5" fill="currentColor"/>
    </svg>`;
  }

  function renderKpis() {
    const r = state.report;
    const k = r.kpis;
    const s = r.series;
    const prevLabel = r.period.days === 1 ? 'yesterday' : `prev. ${r.period.days} days`;
    // Rates are withheld over very short distances (see methodology).
    const totalEvents = (d) => d.alerts.high + d.alerts.medium + d.alerts.low;
    const fleetSize = r.scope.vehicles;

    const tiles = [
      {
        label: 'Distance',
        value: `${compact(k.distanceKm.value)}<small> km</small>`,
        sub: `${num(k.activeVehicles.value)} of ${num(fleetSize)} vehicles active`,
        delta: k.distanceKm,
        spark: s.map((d) => d.distanceKm),
      },
      {
        label: 'Utilisation',
        value:
          k.utilisationPct.value === null
            ? '—'
            : `${num(k.utilisationPct.value, 1)}<small>%</small>`,
        sub: 'moving share of engine-on time',
        delta: k.utilisationPct,
        spark: s.map((d) => d.utilisationPct ?? 0),
      },
      {
        label: 'CO₂ emissions',
        value: `${compact(k.co2Kg.value)}<small> kg</small>`,
        sub:
          k.co2GPerKm.value !== null
            ? `${num(k.co2GPerKm.value)} g/km fleet intensity`
            : 'no distance recorded',
        delta: k.co2Kg,
        spark: s.map((d) => d.co2Kg),
      },
      {
        label: 'Fuel & energy',
        value: `${compact(k.fuelL.value)}<small> L</small>`,
        sub: k.energyKwh.value
          ? `+ ${compact(k.energyKwh.value)} kWh charged (EV)`
          : 'diesel and petrol',
        delta: k.fuelL,
      },
      {
        label: 'Idling',
        value: `${num(k.idleHours.value, k.idleHours.value < 100 ? 1 : 0)}<small> h</small>`,
        sub: `≈ ${num(k.idleFuelL.value)} L fuel burned at idle`,
        delta: k.idleHours,
        spark: s.map((d) => d.idleHours),
      },
      {
        label: 'Safety events',
        value: num(k.events.value),
        sub: `${num(k.highSeverity.value)} high severity`,
        delta: k.events,
        spark: s.map(totalEvents),
      },
      {
        label: 'Risk per 100 km',
        value: k.riskPer100Km.value === null ? '—' : num(k.riskPer100Km.value, 2),
        sub: 'severity-weighted events',
        delta: k.riskPer100Km,
      },
    ];

    $('rpKpis').innerHTML = tiles
      .map(
        (t) => `
      <div class="rp-kpi">
        <div class="rp-kpi-label">${escapeHtml(t.label)}</div>
        <div class="rp-kpi-value">${t.value}</div>
        <div class="rp-kpi-foot">
          ${deltaChip(t.delta, { prevLabel, incomplete: r.period.comparisonComplete === false })}
          ${t.spark && r.period.days > 1 ? sparkline(t.spark) : ''}
        </div>
        <div class="rp-kpi-sub">${escapeHtml(t.sub)}</div>
      </div>`
      )
      .join('');
  }

  // --- Findings ----------------------------------------------------------
  function renderFindings() {
    const r = state.report;
    const byId = new Map(r.perVehicle.map((v) => [v.id, v]));
    const list = $('rpFindings');
    list.innerHTML = '';
    if (!r.findings.length) {
      list.innerHTML =
        '<li class="rp-finding info"><div><strong>Nothing unusual</strong><p>No vehicle stands out on emissions, idling, driving risk or utilisation in this period.</p></div></li>';
      return;
    }
    const icon = { notice: '!', positive: '✓', info: 'i' };
    for (const f of r.findings) {
      const li = document.createElement('li');
      li.className = `rp-finding ${f.kind}`;
      const badge = document.createElement('span');
      badge.className = 'rp-finding-icon';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = icon[f.kind] || 'i';
      const body = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = f.title;
      const p = document.createElement('p');
      p.textContent = f.text;
      body.append(title, p);
      if (f.vehicleIds && f.vehicleIds.length) {
        const chips = document.createElement('div');
        chips.className = 'rp-chips';
        for (const id of f.vehicleIds) {
          const v = byId.get(id);
          if (!v) continue;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'rp-chip';
          b.dataset.vehicle = id;
          b.textContent = `View ${v.label}`;
          chips.appendChild(b);
        }
        body.appendChild(chips);
      }
      li.append(badge, body);
      list.appendChild(li);
    }
  }

  // --- Charts ------------------------------------------------------------
  function baseOptions({ stacked = false, horizontal = false, legend = false, yTitle, max } = {}) {
    const valueAxis = {
      stacked,
      beginAtZero: true,
      max,
      grid: { color: theme.grid, drawTicks: false },
      border: { display: false },
      ticks: { color: theme.muted, padding: 6, maxTicksLimit: 5, callback: (v) => compact(v) },
      title: yTitle
        ? { display: true, text: yTitle, color: theme.muted, font: { size: 11 } }
        : undefined,
    };
    const catAxis = {
      stacked,
      grid: { display: false },
      border: { color: theme.grid },
      ticks: { color: theme.muted, maxRotation: 0, autoSkipPadding: 12 },
    };
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      indexAxis: horizontal ? 'y' : 'x',
      interaction: { mode: 'index', intersect: false, axis: horizontal ? 'y' : 'x' },
      layout: { padding: { top: 4, right: 4 } },
      plugins: {
        legend: legend
          ? {
              display: true,
              position: 'top',
              align: 'start',
              labels: {
                color: theme.text,
                boxWidth: 10,
                boxHeight: 10,
                padding: 14,
                font: { size: 11.5 },
              },
            }
          : { display: false },
        tooltip: {
          backgroundColor: theme === THEMES.print ? '#ffffff' : '#0b0f16',
          borderColor: theme === THEMES.print ? '#cccccc' : '#2a3648',
          borderWidth: 1,
          titleColor: theme.muted,
          bodyColor: theme.text,
          padding: 10,
          boxWidth: 10,
          boxHeight: 2,
          usePointStyle: false,
          titleFont: { weight: '500', size: 11.5 },
          bodyFont: { size: 12.5 },
        },
      },
      scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
    };
  }

  function bar(color, extra = {}) {
    return {
      backgroundColor: color,
      hoverBackgroundColor: color,
      borderRadius: 4,
      borderSkipped: 'start',
      maxBarThickness: 28,
      categoryPercentage: 0.78,
      barPercentage: 0.92,
      ...extra,
    };
  }

  function stackSeg(color, isTop, horizontal = false) {
    // A 2px surface-coloured edge on the value end of every segment opens
    // a gap between stacked segments; only the outermost segment gets the
    // rounded data-end.
    return {
      backgroundColor: color,
      hoverBackgroundColor: color,
      borderColor: theme.surface,
      borderWidth: horizontal ? { right: 2 } : { top: 2 },
      borderRadius: isTop ? 4 : 0,
      borderSkipped: 'start',
      maxBarThickness: 28,
      categoryPercentage: 0.78,
      barPercentage: 0.92,
    };
  }

  function draw(key, canvasId, config) {
    if (state.charts[key]) state.charts[key].destroy();
    state.charts[key] = new Chart($(canvasId), config);
  }

  function dayLabels(series) {
    const opts =
      series.length > 31
        ? { day: 'numeric', month: 'numeric' }
        : { day: 'numeric', month: 'short' };
    return series.map((d) =>
      fmtDay(d.day, series.length <= 8 ? { weekday: 'short', day: 'numeric' } : opts)
    );
  }

  function renderCharts() {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.font.family =
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    Chart.defaults.color = theme.muted;

    const r = state.report;
    const s = r.series;
    const labels = dayLabels(s);
    const single = s.length === 1;

    // Distance and CO2 are separate charts (small multiples) — never one
    // chart with two y-scales.
    draw('distance', 'rpDistance', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Distance (km)', data: s.map((d) => d.distanceKm), ...bar(theme.series) },
        ],
      },
      options: withTooltip(baseOptions(), (v) => `${num(v, 1)} km`),
    });

    draw('co2', 'rpCo2', {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'CO₂ (kg)', data: s.map((d) => d.co2Kg), ...bar(theme.series) }],
      },
      options: withTooltip(baseOptions(), (v) => `${num(v, 1)} kg CO₂`),
    });

    const sevSets = SEVERITIES.map((sev, i) => ({
      label: SEV_LABEL[sev],
      data: s.map((d) => d.alerts[sev]),
      ...stackSeg(theme.sev[sev], i === SEVERITIES.length - 1),
    }));
    // Round the top-most non-zero segment of each stack, not a fixed one.
    sevSets.forEach((ds, i) => {
      ds.borderRadius = (ctx) => {
        const idx = ctx.dataIndex;
        for (let j = SEVERITIES.length - 1; j > i; j--) if (sevSets[j].data[idx] > 0) return 0;
        return 4;
      };
    });
    draw('events', 'rpEvents', {
      type: 'bar',
      data: { labels, datasets: sevSets },
      options: withTooltip(baseOptions({ stacked: true, legend: true }), (v) => num(v), {
        footerTotal: true,
      }),
    });

    const types = r.alertTypes;
    const typeSets = SEVERITIES.map((sev) => ({
      label: SEV_LABEL[sev],
      data: types.map((t) => t[sev]),
      ...stackSeg(theme.sev[sev], false, true),
    }));
    typeSets.forEach((ds, i) => {
      ds.borderRadius = (ctx) => {
        for (let j = SEVERITIES.length - 1; j > i; j--)
          if (typeSets[j].data[ctx.dataIndex] > 0) return 0;
        return 4;
      };
    });
    $('rpTypesWrap').style.height = `${Math.max(160, types.length * 34 + 60)}px`;
    draw('types', 'rpTypes', {
      type: 'bar',
      data: { labels: types.map((t) => humanType(t.type)), datasets: typeSets },
      options: withTooltip(
        baseOptions({ stacked: true, horizontal: true, legend: true }),
        (v) => num(v),
        { footerTotal: true }
      ),
    });

    const vs = [...r.perVehicle].sort(
      (a, b) => b.movingHours + b.idleHours - (a.movingHours + a.idleHours)
    );
    $('rpEngineWrap').style.height = `${Math.max(180, vs.length * 30 + 60)}px`;
    draw('engine', 'rpEngine', {
      type: 'bar',
      data: {
        labels: vs.map((v) => v.label),
        datasets: [
          {
            label: 'Moving',
            data: vs.map((v) => v.movingHours),
            ...stackSeg(theme.moving, false, true),
          },
          {
            label: 'Idling',
            data: vs.map((v) => v.idleHours),
            ...stackSeg(theme.idle, true, true),
          },
        ],
      },
      options: withTooltip(
        baseOptions({ stacked: true, horizontal: true, legend: true }),
        (v) => `${num(v, 1)} h`,
        {
          footer: (items) => {
            const v = vs[items[0].dataIndex];
            return `Idle ${num(v.idlePct, 0)}% of engine-on time`;
          },
        }
      ),
    });

    const iv = [...r.perVehicle]
      .filter((v) => v.co2GPerKm !== null)
      .sort((a, b) => b.co2GPerKm - a.co2GPerKm);
    const fleetIntensity = r.kpis.co2GPerKm.value;
    $('rpIntensityWrap').style.height = `${Math.max(180, iv.length * 30 + 60)}px`;
    const fuelsPresent = [...new Set(iv.map((v) => v.fuelType))];
    draw('intensity', 'rpIntensity', {
      type: 'bar',
      data: {
        labels: iv.map((v) => v.label),
        // One dataset per fuel type keeps colour tied to the entity (fuel
        // type) and gives the legend real meaning.
        datasets: fuelsPresent.map((ft) => ({
          label: FUEL_LABEL[ft],
          data: iv.map((v) => (v.fuelType === ft ? v.co2GPerKm : null)),
          ...bar(theme.fuel[ft], { skipNull: true, grouped: false }),
        })),
      },
      options: (() => {
        const o = withTooltip(
          baseOptions({ horizontal: true, legend: fuelsPresent.length > 1 }),
          (v) => `${num(v)} g CO₂/km`
        );
        o.interaction = { mode: 'nearest', intersect: true, axis: 'y' };
        o.plugins.tooltip.filter = (item) => item.raw !== null;
        o.plugins.fleetLine = { value: fleetIntensity };
        o.layout.padding.top = 20;
        return o;
      })(),
      plugins: [fleetLinePlugin],
    });

    // Narrow periods: a one-day bar chart is just a number, so say so.
    document
      .querySelectorAll('.rp-daily-card')
      .forEach((c) => c.classList.toggle('is-single', single));
  }

  // Draws the fleet-average reference line on the intensity chart, with a
  // direct label (a solid hairline — never dashed).
  const fleetLinePlugin = {
    id: 'fleetLine',
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts || opts.value === null || opts.value === undefined) return;
      const x = chart.scales.x.getPixelForValue(opts.value);
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = theme.text;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top - 14);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.muted;
      ctx.font = "500 11px 'Inter', sans-serif";
      ctx.textAlign = x > chart.chartArea.right - 150 ? 'right' : 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(
        `Fleet average ${num(opts.value)} g/km`,
        x + (ctx.textAlign === 'right' ? -6 : 6),
        top - 3
      );
      ctx.restore();
    },
  };

  function withTooltip(options, formatValue, extra = {}) {
    options.plugins.tooltip.callbacks = {
      label: (item) => ` ${item.dataset.label}: ${formatValue(item.raw)}`,
    };
    if (extra.footerTotal) {
      options.plugins.tooltip.callbacks.footer = (items) =>
        `Total ${num(items.reduce((s, i) => s + (i.raw || 0), 0))}`;
      options.plugins.tooltip.footerColor = theme.text;
    }
    if (extra.footer) {
      options.plugins.tooltip.callbacks.footer = extra.footer;
      options.plugins.tooltip.footerColor = theme.muted;
      options.plugins.tooltip.footerFont = { weight: '400', size: 11.5 };
    }
    return options;
  }

  // --- Heatmap (weekday × hour) -----------------------------------------
  function renderHeatmap() {
    const r = state.report;
    const cells = r.alertHeatmap.cells;
    const max = Math.max(...cells.flat(), 0);
    const steps = theme.heat;
    const grid = $('rpHeat');
    grid.innerHTML = '';

    const corner = document.createElement('div');
    corner.className = 'rp-heat-corner';
    grid.appendChild(corner);
    for (let h = 0; h < 24; h++) {
      const el = document.createElement('div');
      el.className = 'rp-heat-hour';
      el.textContent = h % 3 === 0 ? String(h).padStart(2, '0') : '';
      grid.appendChild(el);
    }
    cells.forEach((row, d) => {
      const day = document.createElement('div');
      day.className = 'rp-heat-day';
      day.textContent = r.alertHeatmap.weekdays[d].slice(0, 3);
      grid.appendChild(day);
      row.forEach((n, h) => {
        const c = document.createElement('div');
        c.className = 'rp-heat-cell';
        if (n > 0 && max > 0) {
          const idx = Math.min(steps.length - 1, Math.floor((n / max) * steps.length - 1e-9));
          c.style.background = steps[Math.max(0, idx)];
        } else {
          c.classList.add('empty');
        }
        const hh = String(h).padStart(2, '0');
        const label = `${r.alertHeatmap.weekdays[d]} ${hh}:00–${String((h + 1) % 24).padStart(2, '0')}:00 — ${n} event${n === 1 ? '' : 's'}`;
        c.title = label;
        c.setAttribute('aria-label', label);
        c.setAttribute('role', 'gridcell');
        grid.appendChild(c);
      });
    });

    const legend = $('rpHeatLegend');
    legend.innerHTML = '';
    const lo = document.createElement('span');
    lo.textContent = 'Fewer';
    legend.appendChild(lo);
    for (const color of steps) {
      const sw = document.createElement('i');
      sw.style.background = color;
      legend.appendChild(sw);
    }
    const hi = document.createElement('span');
    hi.textContent = max ? `More (max ${max} per hour)` : 'More';
    legend.appendChild(hi);
  }

  // --- Fuel mix (tall segmented bar + rows) -----------------------------
  function renderFuelMix() {
    const r = state.report;
    const mix = r.byFuelType;
    const total = mix.reduce((s, f) => s + f.co2Kg, 0);
    const bar = $('rpFuelBar');
    const rows = $('rpFuelRows');
    bar.innerHTML = '';
    rows.innerHTML = '';
    for (const f of mix) {
      const share = total ? (f.co2Kg / total) * 100 : 0;
      const seg = document.createElement('div');
      seg.className = 'rp-fuel-seg';
      seg.style.background = theme.fuel[f.fuelType];
      seg.style.flexGrow = String(Math.max(share, 0.0001));
      seg.title = `${FUEL_LABEL[f.fuelType]}: ${num(f.co2Kg)} kg CO₂ (${num(share)}%)`;
      bar.appendChild(seg);

      const row = document.createElement('div');
      row.className = 'rp-fuel-row';
      row.innerHTML = `
        <span class="rp-key" data-bg="${theme.fuel[f.fuelType]}"></span>
        <span class="rp-fuel-name"></span>
        <span class="rp-fuel-share">${num(share)}%</span>
        <span class="rp-fuel-meta">${num(f.co2Kg)} kg CO₂ · ${num(f.fuelUsed)} ${f.unit} · ${num(f.distanceKm)} km</span>`;
      row.querySelector('.rp-fuel-name').textContent =
        `${FUEL_LABEL[f.fuelType]} · ${f.vehicles} vehicle${f.vehicles === 1 ? '' : 's'}`;
      applyDataStyles(row);
      rows.appendChild(row);
    }
  }

  // --- League table ------------------------------------------------------
  const COLUMNS = [
    { key: 'label', type: 'text' },
    { key: 'activeDays' },
    { key: 'distanceKm' },
    { key: 'co2Kg' },
    { key: 'co2GPerKm' },
    { key: 'utilisationPct' },
    { key: 'idleHours' },
    { key: 'events' },
    { key: 'riskPer100Km' },
  ];

  function sortedVehicles() {
    const { key, dir } = state.sort;
    const mult = dir === 'asc' ? 1 : -1;
    return state.report.perVehicle
      .filter(
        (v) =>
          !state.search ||
          `${v.label} ${v.driver || ''} ${v.id}`.toLowerCase().includes(state.search)
      )
      .sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (typeof av === 'string') return av.localeCompare(bv) * mult;
        return (av - bv) * mult;
      });
  }

  function renderTable() {
    const r = state.report;
    if (!r) return;
    document.querySelectorAll('#rpTable th[data-sort]').forEach((th) => {
      const on = th.dataset.sort === state.sort.key;
      th.setAttribute(
        'aria-sort',
        on ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
      );
    });

    const rows = sortedVehicles();
    const maxKm = Math.max(...r.perVehicle.map((v) => v.distanceKm), 1);
    const maxRisk = Math.max(...r.perVehicle.map((v) => v.riskPer100Km || 0), 0.0001);
    const fleetRisk = r.kpis.riskPer100Km.value;
    const days = r.period.days;

    const tbody = $('rpRows');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="hint">${r.perVehicle.length ? 'No vehicle matches that search.' : 'No vehicles in this scope.'}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map((v) => {
        const riskHigh = fleetRisk && v.riskPer100Km !== null && v.riskPer100Km >= fleetRisk * 1.5;
        const lowUse = days >= 7 && v.activeDays / days <= 0.3;
        return `
        <tr data-id="${escapeHtml(v.id)}" tabindex="0" aria-label="${escapeHtml(v.label)} — open details">
          <td class="rp-veh">
            <span class="rp-veh-label">${escapeHtml(v.label)}</span>
            <span class="rp-veh-meta"><span class="rp-key sm" data-bg="${theme.fuel[v.fuelType]}"></span>${escapeHtml(FUEL_LABEL[v.fuelType])}${v.driver ? ` · ${escapeHtml(v.driver)}` : ''}</span>
          </td>
          <td class="num ${lowUse ? 'flag' : ''}">${num(v.activeDays)}<span class="of">/${days}</span></td>
          <td class="num rp-barcell"><span class="rp-inbar" data-w="${((v.distanceKm / maxKm) * 100).toFixed(1)}"></span><span>${num(v.distanceKm)}</span></td>
          <td class="num">${num(v.co2Kg)}</td>
          <td class="num">${num(v.co2GPerKm)}</td>
          <td class="num">${v.utilisationPct === null ? '—' : `${num(v.utilisationPct, 1)}%`}</td>
          <td class="num">${num(v.idleHours, 1)}</td>
          <td class="num rp-sevs" title="High ${v.alerts.high} · Medium ${v.alerts.medium} · Low ${v.alerts.low}">
            <span>${num(v.events)}</span>
            <span class="rp-sevmini">${v.alerts.high ? `<b class="h">${v.alerts.high}H</b>` : ''}${v.alerts.medium ? `<b class="m">${v.alerts.medium}M</b>` : ''}</span>
          </td>
          <td class="num rp-barcell ${riskHigh ? 'flag' : ''}"><span class="rp-inbar risk" data-w="${(((v.riskPer100Km || 0) / maxRisk) * 100).toFixed(1)}"></span><span>${v.riskPer100Km === null ? '—' : num(v.riskPer100Km, 2)}</span></td>
        </tr>`;
      })
      .join('');
    applyDataStyles(tbody);
  }

  // The app's CSP (style-src 'self') blocks inline style="" attributes in
  // markup, so computed widths and colours are applied through the CSSOM,
  // which CSP permits.
  function applyDataStyles(root) {
    root.querySelectorAll('[data-w]').forEach((el) => (el.style.width = `${el.dataset.w}%`));
    root.querySelectorAll('[data-bg]').forEach((el) => (el.style.background = el.dataset.bg));
  }

  // --- Methodology -------------------------------------------------------
  function renderMethodology() {
    const m = state.report.methodology;
    $('rpFactors').textContent =
      `Diesel ${m.emissionFactorsKg.diesel} kg CO₂-e/L, petrol ${m.emissionFactorsKg.petrol} kg CO₂-e/L, EV ${m.emissionFactorsKg.ev} kg CO₂-e/kWh (grid average).`;
    $('rpWeights').textContent =
      `High ${m.severityWeights.high}, medium ${m.severityWeights.medium}, low ${m.severityWeights.low}, info ${m.severityWeights.info}.`;
  }

  // ---------------------------------------------------------------------
  // Vehicle drill-down
  // ---------------------------------------------------------------------
  async function openDrawer(id, { keepFocus = false } = {}) {
    const r = state.report;
    const v = r && r.perVehicle.find((x) => x.id === id);
    const drawer = $('rpDrawer');
    if (!v) {
      if (state.drawerVehicleId) closeDrawer();
      return;
    }
    const wasOpen = !drawer.hidden;
    state.drawerVehicleId = id;
    $('rpDrawerTitle').textContent = v.label;
    $('rpDrawerMeta').textContent = [FUEL_LABEL[v.fuelType], v.driver, v.id]
      .filter(Boolean)
      .join(' · ');

    const comparable = r.period.comparisonComplete !== false;
    const delta = (cur, prev, better) =>
      deltaChip(
        {
          value: cur,
          previous: prev,
          changePct: prev ? ((cur - prev) / prev) * 100 : cur ? null : 0,
          better,
        },
        { prevLabel: 'prev.' }
      );
    const stats = [
      [
        'Distance',
        `${num(v.distanceKm)} km`,
        comparable ? delta(v.distanceKm, v.previous.distanceKm, 'neutral') : '',
      ],
      ['CO₂', `${num(v.co2Kg)} kg`, comparable ? delta(v.co2Kg, v.previous.co2Kg, 'down') : ''],
      ['Intensity', v.co2GPerKm === null ? '—' : `${num(v.co2GPerKm)} g/km`, ''],
      ['Active days', `${v.activeDays} of ${r.period.days}`, ''],
      ['Utilisation', v.utilisationPct === null ? '—' : `${num(v.utilisationPct, 1)}%`, ''],
      [
        'Idling',
        `${num(v.idleHours, 1)} h`,
        `<span class="rp-delta neutral">≈ ${num(v.idleFuel, 1)} ${v.unit} at idle</span>`,
      ],
      [
        'Safety events',
        num(v.events),
        comparable ? delta(v.events, v.previous.events, 'down') : '',
      ],
      [
        'Risk / 100 km',
        v.riskPer100Km === null ? '—' : num(v.riskPer100Km, 2),
        r.kpis.riskPer100Km.value
          ? `<span class="rp-delta neutral">fleet ${num(r.kpis.riskPer100Km.value, 2)}</span>`
          : '',
      ],
    ];
    $('rpDrawerStats').innerHTML = stats
      .map(
        ([label, value, foot]) =>
          `<div class="rp-dstat"><div class="rp-kpi-label">${escapeHtml(label)}</div><div class="rp-dstat-value">${escapeHtml(value)}</div>${foot || ''}</div>`
      )
      .join('');

    // Daily distance for this vehicle.
    if (state.drawerChart) state.drawerChart.destroy();
    state.drawerChart = new Chart($('rpDrawerChart'), {
      type: 'bar',
      data: {
        labels: dayLabels(v.daily),
        datasets: [
          { label: 'Distance (km)', data: v.daily.map((d) => d.km), ...bar(theme.series) },
        ],
      },
      options: withTooltip(baseOptions(), (x) => `${num(x, 1)} km`),
    });

    // Events by type for this vehicle.
    const types = Object.entries(v.alertsByType).sort((a, b) => b[1] - a[1]);
    const maxType = Math.max(...types.map((t) => t[1]), 1);
    const typeList = $('rpDrawerTypes');
    typeList.innerHTML = '';
    if (!types.length) {
      typeList.innerHTML = '<p class="hint">No events recorded for this vehicle in the period.</p>';
    } else {
      for (const [type, n] of types) {
        const row = document.createElement('div');
        row.className = 'rp-typerow';
        row.innerHTML =
          '<span class="rp-typename"></span><span class="rp-typebar"><i></i></span><span class="num"></span>';
        row.querySelector('.rp-typename').textContent = humanType(type);
        row.querySelector('i').style.width = `${(n / maxType) * 100}%`;
        row.querySelector('.num').textContent = String(n);
        typeList.appendChild(row);
      }
    }

    drawer.hidden = false;
    $('rpScrim').hidden = false;
    document.body.classList.add('rp-drawer-open');
    requestAnimationFrame(() => drawer.classList.add('open'));
    if (!wasOpen && !keepFocus) $('rpDrawerClose').focus();

    // Most recent events (live table, not period-bound — labelled as such).
    const recent = $('rpDrawerRecent');
    recent.innerHTML = '<li class="hint">Loading…</li>';
    try {
      const res = await authedFetch(`/api/alerts?vehicleId=${encodeURIComponent(id)}&limit=12`);
      const rows = res.ok ? await res.json() : [];
      if (state.drawerVehicleId !== id) return;
      recent.innerHTML = '';
      if (!rows.length) recent.innerHTML = '<li class="hint">No events on record.</li>';
      for (const a of rows) {
        const li = document.createElement('li');
        const sev = SEVERITIES.includes(a.severity) ? a.severity : 'info';
        li.innerHTML = `<span class="sev sev-${sev}"></span><span class="rp-recent-type"></span><time></time>`;
        li.querySelector('.sev').textContent = sev;
        li.querySelector('.rp-recent-type').textContent = humanType(a.type || '');
        li.querySelector('time').textContent = new Date(a.t).toLocaleString('en-AU', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
        recent.appendChild(li);
      }
    } catch {
      if (state.drawerVehicleId === id)
        recent.innerHTML = '<li class="hint error">Could not load recent events.</li>';
    }
  }

  function closeDrawer() {
    const drawer = $('rpDrawer');
    const id = state.drawerVehicleId;
    state.drawerVehicleId = null;
    drawer.classList.remove('open');
    $('rpScrim').hidden = true;
    document.body.classList.remove('rp-drawer-open');
    setTimeout(() => {
      if (!state.drawerVehicleId) drawer.hidden = true;
    }, 180);
    const row = id && document.querySelector(`#rpRows tr[data-id="${CSS.escape(id)}"]`);
    if (row) row.focus();
  }

  // ---------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------
  function csvCell(value) {
    if (value === null || value === undefined) return '';
    let s = String(value);
    // Neutralise spreadsheet formula injection from customer-entered text.
    if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCsv(kind) {
    const r = state.report;
    if (!r) return;
    let header;
    let rows;
    if (kind === 'vehicles') {
      header = [
        'vehicle_id',
        'label',
        'driver',
        'fuel_type',
        'active_days',
        'period_days',
        'distance_km',
        'fuel_used',
        'fuel_unit',
        'co2_kg',
        'co2_g_per_km',
        'moving_h',
        'idle_h',
        'utilisation_pct',
        'idle_pct',
        'idle_fuel',
        'trips',
        'events_high',
        'events_medium',
        'events_low',
        'events_info',
        'risk_per_100km',
        'prev_distance_km',
        'prev_co2_kg',
        'prev_events',
      ];
      rows = sortedVehicles().map((v) => [
        v.id,
        v.label,
        v.driver,
        v.fuelType,
        v.activeDays,
        r.period.days,
        v.distanceKm,
        v.fuelUsed,
        v.unit,
        v.co2Kg,
        v.co2GPerKm,
        v.movingHours,
        v.idleHours,
        v.utilisationPct,
        v.idlePct,
        v.idleFuel,
        v.trips,
        v.alerts.high,
        v.alerts.medium,
        v.alerts.low,
        v.alerts.info,
        v.riskPer100Km,
        v.previous.distanceKm,
        v.previous.co2Kg,
        v.previous.events,
      ]);
    } else {
      header = [
        'date',
        'distance_km',
        'co2_kg',
        'moving_h',
        'idle_h',
        'utilisation_pct',
        'active_vehicles',
        'events_high',
        'events_medium',
        'events_low',
        'events_info',
      ];
      rows = r.series.map((d) => [
        d.day,
        d.distanceKm,
        d.co2Kg,
        d.movingHours,
        d.idleHours,
        d.utilisationPct,
        d.activeVehicles,
        d.alerts.high,
        d.alerts.medium,
        d.alerts.low,
        d.alerts.info,
      ]);
    }
    const meta = [
      `# Fleet Shield report — ${kind === 'vehicles' ? 'per vehicle' : 'daily fleet totals'}`,
      `# Period ${r.period.from} to ${r.period.to} (${r.period.timeZone})${r.scope.fuel ? `, fuel type ${r.scope.fuel}` : ''}`,
      `# Generated ${r.generatedAt}`,
    ];
    const csv = [...meta, header.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join(
      '\r\n'
    );
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fleet-shield-${kind}-${r.period.from}_${r.period.to}${r.scope.fuel ? `-${r.scope.fuel}` : ''}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------
  // Entry point — called by app.js whenever the Reports tab is opened.
  // ---------------------------------------------------------------------
  window.loadReports = function loadReports() {
    if (!state.bound) {
      state.bound = true;
      loadPrefs();
      bindToolbar();
      syncToolbar();
      authedFetch('/api/me')
        .then((res) => (res.ok ? res.json() : {}))
        .then((me) => {
          state.orgName = me.orgName || null;
          $('rpPrintOrg').textContent = state.orgName || '';
        })
        .catch(() => {});
    }
    fetchReport();
  };
})();
