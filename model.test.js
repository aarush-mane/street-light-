'use strict';
/* Unit tests for the LumenGrid simulation model. Run with: npm test */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const at = (h, m = 0) => h * 60 + m;

test('initial state: 12 lights, 4 per zone, consistent totals', () => {
  const sim = M.createSimulation();
  const st = sim.getState();
  assert.equal(st.lights.length, 12);
  assert.deepEqual(st.lights.map(l => l.id), [
    'MR-01', 'MR-02', 'MR-03', 'MR-04', 'MS-01', 'MS-02', 'MS-03', 'MS-04', 'CL-01', 'CL-02', 'CL-03', 'CL-04'
  ]);
  const s = sim.summary();
  assert.equal(s.total, 12);
  assert.equal(s.on + s.off, 12);
  s.zones.forEach(z => assert.equal(z.total, 4));
  // 17:50 is before the 18:00 dusk event, so automatic lights start off
  assert.equal(st.minute, at(17, 50));
  assert.equal(s.on, 0);
  assert.equal(s.powerW, 0);
});

test('power model: P = rated × brightness / 100, off draws 0 W', () => {
  const l = { on: true, brightness: 50, ratedW: 100, fault: null };
  assert.equal(M.lightPowerW(l), 50);
  assert.equal(M.lightPowerW({ ...l, on: false }), 0);
  assert.equal(M.lightPowerW({ ...l, brightness: 0 }), 0);
  assert.equal(M.lightPowerW({ ...l, fault: { type: 'lamp' } }), 0);
  assert.equal(M.lightPowerW({ ...l, fault: { type: 'driver' } }), 0);
  // communication loss keeps the last state, so it still consumes power
  assert.equal(M.lightPowerW({ ...l, fault: { type: 'comms' } }), 50);
});

test('zone and total power are sums of individual lights', () => {
  const sim = M.createSimulation();
  sim.setAllPower(true);
  sim.setBrightness('MR-01', 40);
  sim.setBrightness('MS-03', 70);
  sim.setLightPower('CL-02', false);
  const st = sim.getState(), s = sim.summary();
  const sum = st.lights.reduce((a, l) => a + M.lightPowerW(l), 0);
  near(s.powerW, sum);
  near(s.zones.reduce((a, z) => a + z.powerW, 0), s.powerW);
  assert.equal(s.zones.find(z => z.id === 'main').powerW, 340);
  assert.equal(s.on, 11);
  assert.equal(s.off, 1);
});

test('brightness setpoint is kept while a light is off', () => {
  const sim = M.createSimulation();
  sim.setLightPower('MR-02', true);
  sim.setBrightness('MR-02', 60);
  sim.setLightPower('MR-02', false);
  assert.equal(sim.light('MR-02').brightness, 60);
  assert.equal(M.lightPowerW(sim.light('MR-02')), 0);
  sim.setLightPower('MR-02', true);
  assert.equal(M.lightPowerW(sim.light('MR-02')), 60);
  assert.equal(sim.setBrightness('MR-02', 'abc').ok, false);
  sim.setBrightness('MR-02', 150);
  assert.equal(sim.light('MR-02').brightness, 100);
});

test('energy integrates power over time and cost uses the tariff', () => {
  const sim = M.createSimulation();
  sim.setAllPower(true);                    // 12 × 100 W = 1200 W, manual override
  const before = sim.getState().day.energyKWh;
  sim.tick(60);                             // one simulated hour
  const st = sim.getState();
  near(st.day.energyKWh - before, 1.2, 1e-9);   // 1200 W × 1 h / 1000
  sim.setTariff(10);
  const a = sim.analytics('today');
  near(a.costRs, a.energyKWh * 10);
  assert.equal(sim.setTariff(-1).ok, false);
});

test('schedule turns automatic lights on at dusk and off at dawn', () => {
  const sim = M.createSimulation();
  sim.tick(10);                             // 17:50 → 18:00
  assert.equal(sim.summary().on, 12);
  sim.tick(at(12));                         // 18:00 → 06:00 next day
  assert.equal(M.fmtTime(sim.getState().minute), '06:00');
  assert.equal(sim.summary().on, 0);
  assert.equal(sim.getState().day.index, 2);
  assert.equal(sim.getState().pastDays.length, 1);
});

test('schedule windows that cross midnight and ones that do not', () => {
  assert.equal(M.isWithinSchedule(at(23), at(18), at(6)), true);
  assert.equal(M.isWithinSchedule(at(3), at(18), at(6)), true);
  assert.equal(M.isWithinSchedule(at(6), at(18), at(6)), false);
  assert.equal(M.isWithinSchedule(at(12), at(18), at(6)), false);
  assert.equal(M.isWithinSchedule(at(2), at(1), at(5)), true);
  assert.equal(M.isWithinSchedule(at(5), at(1), at(5)), false);
  assert.equal(M.scheduleOnMinutes(at(18), at(6)), 720);
  assert.equal(M.scheduleOnMinutes(at(1), at(5)), 240);

  const sim = M.createSimulation();
  assert.equal(sim.setSchedule({ onTime: '22:00', offTime: '02:00' }).ok, true);
  assert.equal(sim.setSchedule({ onTime: '25:00' }).ok, false);
  assert.equal(sim.setSchedule({ onTime: '02:00' }).ok, false);   // same as off time
  sim.tick(at(22) - at(17, 50));            // to 22:00
  assert.equal(sim.summary().on, 12);
  sim.tick(at(4));                          // to 02:00
  assert.equal(sim.summary().on, 0);
});

test('next schedule action and minutesUntil', () => {
  const sim = M.createSimulation();
  const n = sim.nextScheduleAction();
  assert.deepEqual(n, { on: true, at: at(18), inMinutes: 10 });
  assert.equal(M.minutesUntil(at(18), at(18)), 1440);
  sim.setSchedule({ enabled: false });
  assert.equal(sim.nextScheduleAction(), null);
});

test('manual override survives the schedule until automation resumes', () => {
  const sim = M.createSimulation();
  sim.setLightPower('MR-01', false);        // operator keeps MR-01 off
  assert.equal(sim.light('MR-01').mode, 'manual');
  sim.tick(10);                             // dusk
  assert.equal(sim.light('MR-01').on, false);
  assert.equal(sim.summary().on, 11);
  sim.resumeAutomation();
  assert.equal(sim.light('MR-01').mode, 'auto');
  assert.equal(sim.light('MR-01').on, true);
  assert.equal(sim.summary().on, 12);
});

test('zone actions affect only their zone; global actions affect all healthy lights', () => {
  const sim = M.createSimulation();
  sim.setZonePower('market', true);
  const s = sim.summary();
  assert.equal(s.zones.find(z => z.id === 'market').on, 4);
  assert.equal(s.zones.find(z => z.id === 'main').on, 0);
  assert.equal(s.zones.find(z => z.id === 'campus').on, 0);
  sim.injectFault('CL-01', 'lamp');
  const r = sim.setAllPower(true);
  assert.deepEqual(r.skipped, ['CL-01']);
  assert.equal(sim.summary().on, 11);
});

test('faults: inject, block control, acknowledge, resolve', () => {
  const sim = M.createSimulation();
  sim.tick(10);                             // lights on
  const r = sim.injectFault('MS-02', 'lamp');
  assert.equal(r.ok, true);
  let s = sim.summary();
  assert.equal(s.faults, 1);
  assert.equal(s.zones.find(z => z.id === 'market').faults, 1);
  assert.equal(M.lightStatus(sim.light('MS-02')), 'fault');
  assert.equal(s.powerW, 1100);
  assert.equal(sim.setLightPower('MS-02', false).ok, false);
  assert.equal(sim.setBrightness('MS-02', 20).ok, false);
  assert.equal(sim.injectFault('MS-02', 'driver').ok, false);

  const id = r.alert.id;
  assert.equal(sim.acknowledgeAlert(id).ok, true);
  assert.equal(sim.getState().alerts[0].status, 'acknowledged');
  assert.equal(sim.acknowledgeAlert(id).ok, false);
  assert.equal(sim.resolveAlert(id).ok, true);
  s = sim.summary();
  assert.equal(s.faults, 0);
  assert.equal(sim.light('MS-02').on, true);
  assert.equal(s.powerW, 1200);
  assert.equal(sim.getState().alerts[0].status, 'resolved');
  assert.ok(sim.getState().log.some(e => e.type === 'fault' && /resolved/.test(e.message)));
});

test('demo faults follow a fixed order', () => {
  const sim = M.createSimulation();
  assert.equal(sim.injectDemoFault().alert.lightId, 'MS-02');
  assert.equal(sim.injectDemoFault().alert.lightId, 'CL-03');
  const sim2 = M.createSimulation();
  assert.equal(sim2.injectDemoFault().alert.lightId, 'MS-02');
});

test('adaptive lighting sets automatic brightness from simulated activity', () => {
  const sim = M.createSimulation();
  sim.tick(10);
  sim.setPolicy('adaptive');
  // defaults: main moderate (60), market high (100), campus low (30)
  assert.equal(sim.light('MR-01').brightness, 60);
  assert.equal(sim.light('MS-01').brightness, 100);
  assert.equal(sim.light('CL-01').brightness, 30);
  sim.setActivity('campus', 'high');
  assert.equal(sim.light('CL-01').brightness, 100);
  assert.equal(sim.light('MR-01').brightness, 60);
  // manual lights are not touched by the controller
  sim.setBrightness('MR-02', 90);
  sim.setActivity('main', 'low');
  assert.equal(sim.light('MR-01').brightness, 30);
  assert.equal(sim.light('MR-02').brightness, 90);
  assert.equal(sim.setAdaptiveLevel('low', 5).ok, false);
  sim.setPolicy('eco');
  assert.equal(sim.light('MR-01').brightness, 50);
});

test('savings compare the same interval against the documented baseline', () => {
  const sim = M.createSimulation();
  sim.tick(10);                             // to dusk; before dusk baseline and actual are both 0
  sim.tick(60);                             // full brightness for 1 h = baseline
  let a = sim.analytics('today');
  near(a.energyKWh, a.baselineKWh);
  near(a.savingsKWh, 0);
  sim.setPolicy('eco');                     // 50 % for 1 h saves 0.6 kWh
  sim.tick(60);
  a = sim.analytics('today');
  near(a.baselineKWh, 2.4);
  near(a.energyKWh, 1.8);
  near(a.savingsKWh, 0.6);
  near(a.savingsPct, 25);
  near(a.savingsRs, 0.6 * 8);
  // lights on during the day use more than the baseline: savings go negative
  const sim2 = M.createSimulation({ startMinute: at(12) });
  sim2.setAllPower(true);
  sim2.tick(60);
  assert.ok(sim2.analytics('today').savingsKWh < 0);
});

test('analytics periods: live, today, week, month', () => {
  const sim = M.createSimulation();
  sim.tick(30);
  const live = sim.analytics('live');
  assert.equal(live.labels.length, 60);
  assert.equal(live.unit, 'W');
  near(live.energyKWh, Object.values(live.zoneKWh).reduce((a, b) => a + b, 0), 1e-9);
  const today = sim.analytics('today');
  assert.equal(today.labels.length, 24);
  near(today.energyKWh, sim.getState().day.energyKWh);
  const week = sim.analytics('week');
  assert.equal(week.labels.length, 7);
  assert.equal(week.generated.filter(Boolean).length, 6);   // only today is from this run
  assert.equal(week.hasGenerated, true);
  assert.equal(sim.analytics('month').labels.length, 30);
  // generated history is deterministic
  assert.deepEqual(sim.analytics('week').actual, week.actual);
});

test('slider drags log one entry; reset restores a coherent state', () => {
  const sim = M.createSimulation();
  const logBefore = sim.getState().log.length;
  sim.setBrightness('MR-03', 80, { log: false });
  sim.setBrightness('MR-03', 70, { log: false });
  sim.setBrightness('MR-03', 70, { from: 100 });
  const entries = sim.getState().log.slice(0, sim.getState().log.length - logBefore);
  assert.equal(entries.length, 1);
  assert.match(entries[0].message, /MR-03 brightness set to 70% \(was 100%\)/);

  sim.injectFault('CL-02', 'driver');
  sim.setPolicy('adaptive');
  sim.tick(120);
  sim.reset();
  const st = sim.getState();
  assert.equal(st.minute, at(17, 50));
  assert.equal(st.alerts.length, 0);
  assert.equal(st.policy, 'full');
  assert.equal(st.lights.every(l => !l.fault && l.mode === 'auto' && l.brightness === 100), true);
  assert.equal(st.log.length, 1);
  assert.equal(st.day.energyKWh, 0);
});

test('subscribers are notified on change', () => {
  const sim = M.createSimulation();
  let calls = 0;
  const off = sim.subscribe(() => calls++);
  sim.setLightPower('MR-01', true);
  sim.tick(1);
  off();
  sim.tick(1);
  assert.equal(calls, 2);
});
