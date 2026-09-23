// Run with: node tests/triage.test.js
const assert = require('node:assert/strict');
const { buildSeed } = require('../js/data.js');
const T = require('../js/triage.js');

const now = Date.now();
const seed = buildSeed(now);
const db = { vehicles: seed.vehicles, rentals: seed.rentals };
const answers = (over = {}) => ({
  lockedOut: 'renter', keyLocation: 'phone_key', atVehicle: 'yes',
  safety: [], callback: '(305) 555-0199', notes: '', ...over,
});
const run = (rentalId, vehicleId = '', over = {}, cases = seed.cases) => {
  const ctx = T.validateLookup(db, { rentalId, vehicleId }, cases, now);
  assert.ok(ctx.ok, `lookup failed for ${rentalId}: ${JSON.stringify(ctx.errors)}`);
  return { ctx, d: T.assess(ctx, answers(over), now) };
};

const tests = {
  'online vehicle goes to guided self-serve at P3'() {
    const { d } = run('R-1001');
    assert.equal(d.path, 'troubleshoot');
    assert.equal(d.priority, 'P3');
  },
  'offline vehicle escalates to Tier 2 at P2 and offers the spare key'() {
    const { d } = run('R-1002');
    assert.equal(d.path, 'offline');
    assert.equal(d.priority, 'P2');
    assert.ok(d.flags.some((f) => f.code === 'OFFLINE'));
    assert.match(d.nextSteps[0].text, /lockbox/);
  },
  'missing GPS is flagged and needs a location before dispatch'() {
    const { d } = run('R-1003');
    assert.ok(d.needsLocation);
    assert.ok(d.flags.some((f) => f.code === 'NO_LOCATION'));
  },
  'repeat lockout raises priority and schedules fleet follow-up'() {
    const { d } = run('R-1004');
    assert.equal(d.priority, 'P2');
    assert.ok(d.followUp);
    assert.ok(d.flags.some((f) => f.code === 'REPEAT' && /#3/.test(f.label)));
  },
  'existing open case is surfaced instead of creating a duplicate'() {
    const { d, ctx } = run('R-1005');
    assert.equal(d.path, 'duplicate');
    assert.equal(ctx.openCase.id, 'CS-24817');
  },
  'operator can override the duplicate and open a linked case'() {
    const { d, ctx } = run('R-1005', '', { forceNew: true });
    assert.notEqual(d.path, 'duplicate');
    const c = T.createCase(ctx, answers({ forceNew: true }), d, now, 'CS-1');
    assert.equal(c.linkedCase, 'CS-24817');
  },
  'safety concern overrides everything, including an open case'() {
    const { d } = run('R-1005', '', { safety: ['child_pet'] });
    assert.equal(d.path, 'emergency');
    assert.equal(d.priority, 'P1');
    assert.match(d.nextSteps[0].strong, /911/);
  },
  'non-medical safety concern says get safe first, not 911'() {
    const { d } = run('R-1001', '', { safety: ['unsafe_location'] });
    assert.equal(d.path, 'emergency');
    assert.doesNotMatch(d.nextSteps[0].strong, /911/);
  },
  'messy rental IDs are normalised'() {
    for (const raw of ['r1001', ' R 1001 ', '1001', 'r-1001']) {
      const ctx = T.validateLookup(db, { rentalId: raw }, seed.cases, now);
      assert.ok(ctx.ok, raw);
      assert.equal(ctx.rental.rentalId, 'R-1001');
    }
  },
  'unknown rental ID suggests the closest real one'() {
    const ctx = T.validateLookup(db, { rentalId: 'R-1011' }, seed.cases, now);
    assert.equal(ctx.ok, false);
    assert.ok(ctx.errors[0].suggestions.some((s) => s.set.rentalId === 'R-1001'));
  },
  'garbage rental ID gets a format hint'() {
    const ctx = T.validateLookup(db, { rentalId: 'abc!' }, seed.cases, now);
    assert.equal(ctx.ok, false);
    assert.match(ctx.errors[0].message, /look like R-1001/);
  },
  'vehicle not on the rental is rejected with both fixes offered'() {
    const ctx = T.validateLookup(db, { rentalId: 'R-1001', vehicleId: 'V-104' }, seed.cases, now);
    assert.equal(ctx.ok, false);
    const labels = ctx.errors[0].suggestions.map((s) => s.label).join(' | ');
    assert.match(labels, /V-101/);
    assert.match(labels, /R-1004/);
  },
  'plate number is accepted in place of vehicle ID'() {
    const ctx = T.validateLookup(db, { rentalId: 'R-1002', vehicleId: 'mqr-8840' }, seed.cases, now);
    assert.ok(ctx.ok);
    assert.equal(ctx.vehicle.vehicleId, 'V-102');
  },
  'completed rental is allowed but warned and flagged'() {
    const { ctx, d } = run('R-1006');
    assert.ok(ctx.warnings.length);
    assert.ok(d.flags.some((f) => f.code === 'RENTAL_INACTIVE'));
  },
  'a second report on the same vehicle is caught as a duplicate'() {
    const { ctx, d } = run('R-1001');
    const c = T.createCase(ctx, answers(), d, now, 'CS-9');
    const again = run('R-1001', '', {}, [c, ...seed.cases]);
    assert.equal(again.d.path, 'duplicate');
    assert.equal(again.ctx.openCase.id, 'CS-9');
  },
  'remote unlock only succeeds when online and supported'() {
    const byId = (id) => db.vehicles.find((v) => v.vehicleId === id);
    assert.equal(T.remoteUnlockSucceeds(byId('V-101')), true);
    assert.equal(T.remoteUnlockSucceeds(byId('V-102')), false);
    assert.equal(T.remoteUnlockSucceeds(byId('V-103')), false);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('  ✓ ' + name); } catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}
console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
