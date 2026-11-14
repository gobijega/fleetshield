// Route geometry sanity: simulated vehicles drive these loops, so each one
// must be a continuous road path (no gaps or jumps the spoofing check would
// flag) that returns to its depot.
const test = require('node:test');
const assert = require('node:assert');
const { ROUTES, haversineKm } = require('../lib/fleet-data');

test('every route is a continuous road-following loop', () => {
  for (const [key, route] of Object.entries(ROUTES)) {
    assert.ok(route.length >= 20, `${key}: expected road geometry, got ${route.length} points`);
    let total = 0;
    for (let i = 0; i < route.length; i++) {
      const a = route[i];
      const b = route[(i + 1) % route.length];
      assert.ok(Number.isFinite(a.lat) && Number.isFinite(a.lng), `${key}[${i}] is not a coordinate`);
      const km = haversineKm(a, b);
      assert.ok(km < 3, `${key}: ${km.toFixed(2)} km jump after point ${i}`);
      total += km;
    }
    assert.ok(total > 5 && total < 60, `${key}: loop length ${total.toFixed(1)} km out of range`);
  }
});
