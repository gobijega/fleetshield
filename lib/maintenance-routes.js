'use strict';
/**
 * Maintenance API: preventive-maintenance schedules, work orders and
 * pre-start inspections. Mounted by server.js after requireAuth/requireCsrf,
 * so every route has req.orgId and req.session.username, and every query is
 * scoped to the caller's organisation.
 *
 * Also runs the PM sweep: when a schedule falls due (or due soon) against
 * the telematics odometer or the calendar, a preventive work order is
 * raised automatically, one open work order per schedule.
 */
const m = require('./maintenance');

const SWEEP_MS = 15 * 60 * 1000;
const CRITICAL_INSPECTION_ITEMS = new Set([
  'Brakes',
  'Tyres and wheel nuts',
  'Lights and indicators',
  'Seatbelts',
]);

function rowToSchedule(r) {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    name: r.name,
    intervalKm: r.interval_km,
    intervalDays: r.interval_days,
    lastDoneKm: r.last_done_km != null ? Number(r.last_done_km) : null,
    lastDoneAt: r.last_done_at,
    checklist: r.checklist || [],
    active: r.active,
  };
}

// node-postgres returns DATE columns as a Date at local midnight; read the
// local calendar parts back rather than converting through UTC.
function dateOnly(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rowToWorkOrder(r) {
  return {
    id: r.id,
    number: Number(r.number),
    ref: `WO-${String(r.number).padStart(5, '0')}`,
    vehicleId: r.vehicle_id,
    vehicleLabel: r.vehicle_label,
    title: r.title,
    description: r.description,
    type: r.type,
    priority: r.priority,
    status: r.status,
    assignee: r.assignee,
    dueDate: dateOnly(r.due_date),
    scheduleId: r.schedule_id,
    inspectionId: r.inspection_id,
    alertId: r.alert_id,
    outOfService: r.out_of_service,
    checklist: r.checklist || [],
    costs: r.costs || [],
    costTotal: m.costTotal(r.costs),
    completionOdometerKm:
      r.completion_odometer_km != null ? Number(r.completion_odometer_km) : null,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    completedBy: r.completed_by,
  };
}

function rowToInspection(r) {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    vehicleLabel: r.vehicle_label,
    ts: r.ts,
    inspector: r.inspector,
    odometerKm: r.odometer_km != null ? Number(r.odometer_km) : null,
    results: r.results,
    passed: r.passed,
    notes: r.notes,
  };
}

function attachMaintenanceRoutes(app, { db, getOrgState, uid, audit }) {
  const odometerOf = (v) =>
    Math.round(((v.startingOdometerKm || 0) + (v.odometerKm || 0)) * 10) / 10;

  async function logEvent(orgId, woId, username, kind, detail) {
    await db.query(
      'INSERT INTO work_order_events (work_order_id, org_id, username, kind, detail) VALUES ($1,$2,$3,$4,$5)',
      [woId, orgId, username || null, kind, detail || null]
    );
  }

  async function createWorkOrder(orgId, wo, username, eventDetail) {
    const id = uid('wo');
    const orgState = getOrgState(orgId);
    const v = wo.vehicleId ? orgState.vehicles.get(wo.vehicleId) : null;
    const { rows } = await db.query(
      `INSERT INTO work_orders
        (id, org_id, vehicle_id, vehicle_label, title, description, type, priority, assignee, due_date,
         schedule_id, inspection_id, alert_id, out_of_service, checklist, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        id,
        orgId,
        v ? v.id : null,
        v ? v.plate || v.label : null,
        wo.title,
        wo.description || null,
        wo.type,
        wo.priority,
        wo.assignee || null,
        wo.dueDate || null,
        wo.scheduleId || null,
        wo.inspectionId || null,
        wo.alertId || null,
        Boolean(wo.outOfService),
        JSON.stringify(wo.checklist || []),
        username || null,
      ]
    );
    await logEvent(orgId, id, username, 'created', eventDetail || 'Work order created');
    return rowToWorkOrder(rows[0]);
  }

  // ------------------------------------------------------------ seeding
  // Give every vehicle the default PM program once, so the tab is useful
  // from day one. Spread the "last done" points so a fleet doesn't fall due
  // all at once.
  async function seedDefaultSchedules(orgId) {
    const orgState = getOrgState(orgId);
    const { rows } = await db.query(
      'SELECT DISTINCT vehicle_id FROM maintenance_schedules WHERE org_id = $1',
      [orgId]
    );
    const have = new Set(rows.map((r) => r.vehicle_id));
    let i = 0;
    for (const v of orgState.vehicles.values()) {
      i++;
      if (have.has(v.id)) continue;
      const odo = odometerOf(v);
      for (const [k, s] of m.defaultSchedules(v.fuelType).entries()) {
        const lastKm = s.intervalKm ? Math.floor(odo / s.intervalKm) * s.intervalKm : null;
        const ageDays = s.intervalDays ? (i * 37 + k * 53) % Math.max(1, s.intervalDays - 5) : null;
        const lastAt =
          ageDays != null ? new Date(Date.now() - ageDays * 86400000).toISOString() : null;
        await db.query(
          `INSERT INTO maintenance_schedules (id, org_id, vehicle_id, name, interval_km, interval_days, last_done_km, last_done_at, checklist)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            uid('pm'),
            orgId,
            v.id,
            s.name,
            s.intervalKm,
            s.intervalDays,
            lastKm,
            lastAt,
            JSON.stringify(s.checklist),
          ]
        );
      }
    }
  }

  // ------------------------------------------------------------- PM sweep
  async function pmSweep(orgId) {
    const orgState = getOrgState(orgId);
    const { rows } = await db.query(
      `SELECT s.*, (SELECT COUNT(*) FROM work_orders w WHERE w.schedule_id = s.id AND w.status IN ('open','in_progress','on_hold')) AS open_wos
       FROM maintenance_schedules s WHERE s.org_id = $1 AND s.active`,
      [orgId]
    );
    let raised = 0;
    for (const r of rows) {
      if (Number(r.open_wos) > 0) continue;
      const v = orgState.vehicles.get(r.vehicle_id);
      if (!v) continue;
      const s = rowToSchedule(r);
      const due = m.computeDue(s, odometerOf(v));
      if (due.status === 'ok') continue;
      const reason = [
        due.kmRemaining != null
          ? due.kmRemaining < 0
            ? `${-due.kmRemaining} km overdue`
            : `${due.kmRemaining} km to go`
          : null,
        due.daysRemaining != null
          ? due.daysRemaining < 0
            ? `${-due.daysRemaining} days overdue`
            : `${due.daysRemaining} days to go`
          : null,
      ]
        .filter(Boolean)
        .join(', ');
      await createWorkOrder(
        orgId,
        {
          title: `${s.name}: ${v.plate || v.label}`,
          description: `Raised automatically by the preventive maintenance schedule (${reason}). Odometer at raise: ${Math.round(odometerOf(v))} km.`,
          type: 'preventive',
          priority: m.pmPriority(due),
          vehicleId: v.id,
          dueDate: m.pmWorkOrderDueDate(due),
          scheduleId: s.id,
          checklist: (s.checklist || []).map((text) => ({ text, done: false })),
        },
        'system',
        `Raised automatically: ${reason}`
      );
      raised++;
    }
    return raised;
  }

  async function sweepAll(orgIds) {
    for (const orgId of orgIds) {
      try {
        await seedDefaultSchedules(orgId);
        await pmSweep(orgId);
      } catch (err) {
        console.error('PM sweep failed for org', orgId, err.message);
      }
    }
  }

  // ---------------------------------------------------------- overview
  app.get('/api/maintenance/overview', async (req, res) => {
    try {
      const orgState = getOrgState(req.orgId);
      const [sched, wos, insp, cost] = await Promise.all([
        db.query('SELECT * FROM maintenance_schedules WHERE org_id = $1 AND active', [req.orgId]),
        db.query(
          `SELECT vehicle_id, status, out_of_service, due_date, priority FROM work_orders
           WHERE org_id = $1 AND status IN ('open','in_progress','on_hold')`,
          [req.orgId]
        ),
        db.query(
          `SELECT DISTINCT ON (vehicle_id) vehicle_id, ts, passed FROM inspections
           WHERE org_id = $1 ORDER BY vehicle_id, ts DESC`,
          [req.orgId]
        ),
        db.query(
          `SELECT costs FROM work_orders WHERE org_id = $1 AND status = 'done' AND completed_at > now() - interval '30 days'`,
          [req.orgId]
        ),
      ]);
      const today = m.localDate();
      const vehicles = Array.from(orgState.vehicles.values()).map((v) => {
        const odo = odometerOf(v);
        const items = sched.rows
          .filter((r) => r.vehicle_id === v.id)
          .map((r) => ({ name: r.name, ...m.computeDue(rowToSchedule(r), odo) }));
        const rank = { overdue: 0, due_soon: 1, ok: 2 };
        items.sort(
          (a, b) =>
            rank[a.status] - rank[b.status] ||
            (a.daysRemaining ?? (a.kmRemaining ?? 1e9) / 50) -
              (b.daysRemaining ?? (b.kmRemaining ?? 1e9) / 50)
        );
        const openWos = wos.rows.filter((w) => w.vehicle_id === v.id);
        const lastInsp = insp.rows.find((r) => r.vehicle_id === v.id);
        return {
          id: v.id,
          plate: v.plate || null,
          label: v.label,
          driver: v.driver,
          odometerKm: odo,
          next: items[0] || null,
          pmOverdue: items.filter((x) => x.status === 'overdue').length,
          pmDueSoon: items.filter((x) => x.status === 'due_soon').length,
          openWorkOrders: openWos.length,
          outOfService: openWos.some((w) => w.out_of_service),
          lastInspection: lastInsp ? { ts: lastInsp.ts, passed: lastInsp.passed } : null,
        };
      });
      const open = wos.rows;
      res.json({
        vehicles,
        kpis: {
          vehicles: vehicles.length,
          outOfService: vehicles.filter((v) => v.outOfService).length,
          pmOverdue: vehicles.reduce((s, v) => s + v.pmOverdue, 0),
          pmDueSoon: vehicles.reduce((s, v) => s + v.pmDueSoon, 0),
          openWorkOrders: open.length,
          overdueWorkOrders: open.filter((w) => w.due_date && dateOnly(w.due_date) < today).length,
          inspectedLast24h: insp.rows.filter(
            (r) => Date.now() - new Date(r.ts).getTime() < 86400000
          ).length,
          cost30d: Math.round(cost.rows.reduce((s, r) => s + m.costTotal(r.costs), 0) * 100) / 100,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'overview failed' });
    }
  });

  // ---------------------------------------------------------- schedules
  app.get('/api/maintenance/schedules', async (req, res) => {
    try {
      const orgState = getOrgState(req.orgId);
      const { rows } = await db.query(
        `SELECT s.*, (SELECT id FROM work_orders w WHERE w.schedule_id = s.id AND w.status IN ('open','in_progress','on_hold') LIMIT 1) AS open_wo
         FROM maintenance_schedules s WHERE s.org_id = $1 ORDER BY s.vehicle_id, s.name`,
        [req.orgId]
      );
      res.json(
        rows.map((r) => {
          const s = rowToSchedule(r);
          const v = orgState.vehicles.get(s.vehicleId);
          return {
            ...s,
            openWorkOrderId: r.open_wo,
            odometerKm: v ? odometerOf(v) : null,
            due: v ? m.computeDue(s, odometerOf(v)) : null,
          };
        })
      );
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'query failed' });
    }
  });

  app.post('/api/maintenance/schedules', async (req, res) => {
    const s = m.validateSchedule(req.body);
    if (s.error) return res.status(400).json({ error: s.error });
    const v = getOrgState(req.orgId).vehicles.get(s.vehicleId);
    if (!v) return res.status(404).json({ error: 'vehicle not found' });
    try {
      const { rows } = await db.query(
        `INSERT INTO maintenance_schedules (id, org_id, vehicle_id, name, interval_km, interval_days, last_done_km, last_done_at, checklist)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8) RETURNING *`,
        [
          uid('pm'),
          req.orgId,
          v.id,
          s.name,
          s.intervalKm,
          s.intervalDays,
          odometerOf(v),
          JSON.stringify(s.checklist),
        ]
      );
      await audit('maintenance_schedule_created', {
        orgId: req.orgId,
        username: req.session.username,
        ip: req.ip,
        detail: `${rows[0].id}: ${s.name}`,
      });
      res.status(201).json(rowToSchedule(rows[0]));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'insert failed' });
    }
  });

  app.patch('/api/maintenance/schedules/:id', async (req, res) => {
    const s = m.validateSchedule(req.body, { partial: true });
    if (s.error) return res.status(400).json({ error: s.error });
    const cols = {
      name: 'name',
      intervalKm: 'interval_km',
      intervalDays: 'interval_days',
      checklist: 'checklist',
      active: 'active',
    };
    const keys = Object.keys(s).filter((k) => cols[k]);
    if (!keys.length) return res.status(400).json({ error: 'nothing to update' });
    try {
      const { rows } = await db.query(
        `UPDATE maintenance_schedules SET ${keys.map((k, i) => `${cols[k]} = $${i + 3}`).join(', ')}
         WHERE id = $1 AND org_id = $2 RETURNING *`,
        [
          req.params.id,
          req.orgId,
          ...keys.map((k) => (k === 'checklist' ? JSON.stringify(s[k]) : s[k])),
        ]
      );
      if (!rows.length) return res.status(404).json({ error: 'schedule not found' });
      if (!rows[0].interval_km && !rows[0].interval_days) {
        return res.status(400).json({ error: 'a schedule needs a distance or time interval' });
      }
      res.json(rowToSchedule(rows[0]));
    } catch (err) {
      if (err.code === '23514')
        return res.status(400).json({ error: 'a schedule needs a distance or time interval' });
      console.error(err);
      res.status(500).json({ error: 'update failed' });
    }
  });

  app.post('/api/maintenance/schedules/:id/raise', async (req, res) => {
    try {
      const { rows } = await db.query(
        'SELECT * FROM maintenance_schedules WHERE id = $1 AND org_id = $2',
        [req.params.id, req.orgId]
      );
      if (!rows.length) return res.status(404).json({ error: 'schedule not found' });
      const s = rowToSchedule(rows[0]);
      const open = await db.query(
        `SELECT id FROM work_orders WHERE schedule_id = $1 AND status IN ('open','in_progress','on_hold') LIMIT 1`,
        [s.id]
      );
      if (open.rows.length)
        return res.status(409).json({
          error: 'an open work order already exists for this schedule',
          id: open.rows[0].id,
        });
      const v = getOrgState(req.orgId).vehicles.get(s.vehicleId);
      const due = v ? m.computeDue(s, odometerOf(v)) : { status: 'ok' };
      const wo = await createWorkOrder(
        req.orgId,
        {
          title: `${s.name}: ${v ? v.plate || v.label : 'vehicle'}`,
          description: 'Raised from the preventive maintenance schedule.',
          type: 'preventive',
          priority: m.pmPriority(due),
          vehicleId: s.vehicleId,
          dueDate: m.pmWorkOrderDueDate(due),
          scheduleId: s.id,
          checklist: (s.checklist || []).map((text) => ({ text, done: false })),
        },
        req.session.username,
        'Raised from schedule'
      );
      res.status(201).json(wo);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'raise failed' });
    }
  });

  // -------------------------------------------------------- work orders
  app.get('/api/work-orders', async (req, res) => {
    const params = [req.orgId];
    const where = ['org_id = $1'];
    const st = req.query.status;
    if (st === 'open') where.push(`status IN ('open','in_progress','on_hold')`);
    else if (st === 'closed') where.push(`status IN ('done','cancelled')`);
    else if (m.WO_STATUSES.includes(st)) {
      params.push(st);
      where.push(`status = $${params.length}`);
    }
    if (req.query.vehicleId) {
      params.push(String(req.query.vehicleId));
      where.push(`vehicle_id = $${params.length}`);
    }
    try {
      const { rows } = await db.query(
        `SELECT * FROM work_orders WHERE ${where.join(' AND ')}
         ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END,
                  CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                  due_date NULLS LAST, created_at DESC
         LIMIT 500`,
        params
      );
      res.json(rows.map(rowToWorkOrder));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'query failed' });
    }
  });

  app.get('/api/work-orders/:id', async (req, res) => {
    try {
      const { rows } = await db.query('SELECT * FROM work_orders WHERE id = $1 AND org_id = $2', [
        req.params.id,
        req.orgId,
      ]);
      if (!rows.length) return res.status(404).json({ error: 'work order not found' });
      const ev = await db.query(
        'SELECT ts, username, kind, detail FROM work_order_events WHERE work_order_id = $1 AND org_id = $2 ORDER BY ts ASC',
        [req.params.id, req.orgId]
      );
      res.json({ ...rowToWorkOrder(rows[0]), events: ev.rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'query failed' });
    }
  });

  app.post('/api/work-orders', async (req, res) => {
    const wo = m.validateWorkOrder(req.body);
    if (wo.error) return res.status(400).json({ error: wo.error });
    if (wo.vehicleId && !getOrgState(req.orgId).vehicles.has(wo.vehicleId)) {
      return res.status(404).json({ error: 'vehicle not found' });
    }
    if (req.body && req.body.alertId) wo.alertId = String(req.body.alertId).slice(0, 64);
    try {
      const out = await createWorkOrder(req.orgId, wo, req.session.username, 'Work order created');
      await audit('work_order_created', {
        orgId: req.orgId,
        username: req.session.username,
        ip: req.ip,
        detail: `${out.ref}: ${out.title}`,
      });
      res.status(201).json(out);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'insert failed' });
    }
  });

  const STATUS_LABEL = {
    open: 'Open',
    in_progress: 'In progress',
    on_hold: 'On hold',
    done: 'Done',
    cancelled: 'Cancelled',
  };

  app.patch('/api/work-orders/:id', async (req, res) => {
    try {
      const { rows } = await db.query('SELECT * FROM work_orders WHERE id = $1 AND org_id = $2', [
        req.params.id,
        req.orgId,
      ]);
      if (!rows.length) return res.status(404).json({ error: 'work order not found' });
      const current = rowToWorkOrder(rows[0]);
      const v = m.validateWorkOrderPatch(req.body, current);
      if (v.error) return res.status(400).json({ error: v.error });
      const c = v.changes;
      if (!Object.keys(c).length) return res.json(current);
      const cols = {
        status: 'status',
        priority: 'priority',
        title: 'title',
        description: 'description',
        assignee: 'assignee',
        dueDate: 'due_date',
        outOfService: 'out_of_service',
        checklist: 'checklist',
        costs: 'costs',
      };
      const sets = [];
      const vals = [req.params.id, req.orgId];
      for (const k of Object.keys(c)) {
        vals.push(k === 'checklist' || k === 'costs' ? JSON.stringify(c[k]) : c[k]);
        sets.push(`${cols[k]} = $${vals.length}`);
      }
      const veh = current.vehicleId ? getOrgState(req.orgId).vehicles.get(current.vehicleId) : null;
      const completing = c.status === 'done' && current.status !== 'done';
      const reopening =
        c.status &&
        !['done', 'cancelled'].includes(c.status) &&
        ['done', 'cancelled'].includes(current.status);
      if (completing) {
        vals.push(req.session.username || null);
        sets.push(`completed_at = now(), completed_by = $${vals.length}`);
        vals.push(veh ? odometerOf(veh) : null);
        sets.push(`completion_odometer_km = $${vals.length}`);
        sets.push('out_of_service = false');
      }
      if (reopening)
        sets.push('completed_at = NULL, completed_by = NULL, completion_odometer_km = NULL');
      sets.push('updated_at = now()');
      const upd = await db.query(
        `UPDATE work_orders SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
        vals
      );

      // Completing a preventive work order resets its schedule from the
      // current telematics odometer and today's date.
      if (completing && current.scheduleId) {
        await db.query(
          'UPDATE maintenance_schedules SET last_done_km = $1, last_done_at = now() WHERE id = $2 AND org_id = $3',
          [veh ? odometerOf(veh) : null, current.scheduleId, req.orgId]
        );
      }
      const u = req.session.username;
      if (c.status && c.status !== current.status) {
        await logEvent(
          req.orgId,
          current.id,
          u,
          'status',
          `${STATUS_LABEL[current.status]} → ${STATUS_LABEL[c.status]}`
        );
        await audit('work_order_status', {
          orgId: req.orgId,
          username: u,
          ip: req.ip,
          detail: `${current.ref}: ${current.status} -> ${c.status}`,
        });
      }
      if (c.assignee !== undefined && c.assignee !== current.assignee)
        await logEvent(req.orgId, current.id, u, 'update', `Assigned to ${c.assignee || 'nobody'}`);
      if (c.priority && c.priority !== current.priority)
        await logEvent(
          req.orgId,
          current.id,
          u,
          'update',
          `Priority ${current.priority} → ${c.priority}`
        );
      if (c.dueDate !== undefined && c.dueDate !== current.dueDate)
        await logEvent(req.orgId, current.id, u, 'update', `Due date ${c.dueDate || 'cleared'}`);
      if (c.outOfService !== undefined && c.outOfService !== current.outOfService) {
        await logEvent(
          req.orgId,
          current.id,
          u,
          'update',
          c.outOfService ? 'Vehicle marked out of service' : 'Vehicle returned to service'
        );
      }
      if (c.costs)
        await logEvent(
          req.orgId,
          current.id,
          u,
          'update',
          `Costs updated: total ${m.costTotal(c.costs).toFixed(2)}`
        );
      if (c.checklist) {
        const done = c.checklist.filter((i) => i.done).length;
        await logEvent(
          req.orgId,
          current.id,
          u,
          'update',
          `Checklist ${done}/${c.checklist.length}`
        );
      }
      res.json(rowToWorkOrder(upd.rows[0]));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'update failed' });
    }
  });

  app.post('/api/work-orders/:id/comments', async (req, res) => {
    const text =
      typeof (req.body && req.body.text) === 'string' ? req.body.text.trim().slice(0, 2000) : '';
    if (!text) return res.status(400).json({ error: 'text is required' });
    try {
      const { rows } = await db.query('SELECT id FROM work_orders WHERE id = $1 AND org_id = $2', [
        req.params.id,
        req.orgId,
      ]);
      if (!rows.length) return res.status(404).json({ error: 'work order not found' });
      await logEvent(req.orgId, req.params.id, req.session.username, 'comment', text);
      await db.query('UPDATE work_orders SET updated_at = now() WHERE id = $1 AND org_id = $2', [
        req.params.id,
        req.orgId,
      ]);
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'comment failed' });
    }
  });

  // -------------------------------------------------------- inspections
  app.get('/api/inspections/template', (req, res) => res.json({ items: m.INSPECTION_ITEMS }));

  app.get('/api/inspections', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    try {
      const { rows } = await db.query(
        'SELECT * FROM inspections WHERE org_id = $1 ORDER BY ts DESC LIMIT $2',
        [req.orgId, limit]
      );
      res.json(rows.map(rowToInspection));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'query failed' });
    }
  });

  app.post('/api/inspections', async (req, res) => {
    const insp = m.validateInspection(req.body);
    if (insp.error) return res.status(400).json({ error: insp.error });
    const v = getOrgState(req.orgId).vehicles.get(insp.vehicleId);
    if (!v) return res.status(404).json({ error: 'vehicle not found' });
    try {
      const id = uid('insp');
      const { rows } = await db.query(
        `INSERT INTO inspections (id, org_id, vehicle_id, vehicle_label, inspector, odometer_km, results, passed, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          id,
          req.orgId,
          v.id,
          v.plate || v.label,
          insp.inspector,
          odometerOf(v),
          JSON.stringify(insp.results),
          insp.passed,
          insp.notes,
          req.session.username || null,
        ]
      );
      let workOrder = null;
      if (!insp.passed) {
        // Failed items raise one corrective work order. A failed
        // safety-critical item also takes the vehicle out of service until
        // the work order is completed.
        const critical = insp.failed.some((f) => CRITICAL_INSPECTION_ITEMS.has(f.item));
        workOrder = await createWorkOrder(
          req.orgId,
          {
            title: `Inspection defects: ${v.plate || v.label}`,
            description: `Raised from the pre-start inspection by ${insp.inspector}. Failed: ${insp.failed
              .map((f) => f.item + (f.note ? ` (${f.note})` : ''))
              .join('; ')}.`,
            type: 'corrective',
            priority: critical ? 'critical' : 'high',
            vehicleId: v.id,
            dueDate: new Date(Date.now() + (critical ? 0 : 3) * 86400000)
              .toISOString()
              .slice(0, 10),
            inspectionId: id,
            outOfService: critical,
            checklist: insp.failed.map((f) => ({
              text: `Rectify: ${f.item}${f.note ? ` (${f.note})` : ''}`,
              done: false,
            })),
          },
          req.session.username,
          `Raised from failed inspection${critical ? '; vehicle out of service' : ''}`
        );
      }
      await audit('inspection_submitted', {
        orgId: req.orgId,
        username: req.session.username,
        ip: req.ip,
        detail: `${id}: ${v.plate || v.label} ${insp.passed ? 'passed' : `failed (${insp.failed.length})`}`,
      });
      res.status(201).json({ inspection: rowToInspection(rows[0]), workOrder });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'insert failed' });
    }
  });

  return {
    sweepAll,
    startSweeps(listOrgIds) {
      const run = async () => sweepAll(await listOrgIds());
      run();
      return setInterval(run, SWEEP_MS);
    },
  };
}

module.exports = { attachMaintenanceRoutes, rowToWorkOrder, rowToSchedule };
