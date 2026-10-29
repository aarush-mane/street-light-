/*
 * LumenGrid simulation model.
 *
 * The single source of truth for every streetlight, the simulated clock,
 * automation, faults, the activity log and all energy figures.
 * It has no DOM code, so it runs in the browser (window.LumenModel) and in
 * Node for the unit tests (require('./js/model.js')).
 *
 * Everything here is a SIMULATION. No physical lights, sensors or servers
 * are connected.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LumenModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants and configuration
   * ------------------------------------------------------------------ */
  var MIN_PER_DAY = 1440;

  var ZONES = [
    { id: 'main',   name: 'Main Road',     code: 'MR', color: '#f2a516' },
    { id: 'market', name: 'Market Street', code: 'MS', color: '#e8794a' },
    { id: 'campus', name: 'Campus Lane',   code: 'CL', color: '#5b8def' }
  ];

  var DEFAULTS = {
    polesPerZone: 4,
    ratedW: 100,                       // rated LED power per pole at 100 %
    startMinute: 17 * 60 + 50,         // 17:50 on Day 1, just before dusk
    tariff: 8,                         // ₹ per kWh (demo default)
    schedule: { enabled: true, onTime: 18 * 60, offTime: 6 * 60 },
    policy: 'full',                    // brightness policy for automatic lights
    ecoLevel: 50,
    adaptiveLevels: { low: 30, moderate: 60, high: 100 },
    activity: { main: 'moderate', market: 'high', campus: 'low' },
    liveWindow: 60,                    // minutes kept for the Live chart
    logLimit: 300
  };

  var POLICIES = {
    full:     { label: 'Full brightness', short: 'Full' },
    eco:      { label: 'Eco Mode',        short: 'Eco' },
    adaptive: { label: 'Adaptive Lighting', short: 'Adaptive' }
  };

  var ACTIVITY = {
    low:      { label: 'Low',      hint: 'few vehicles or pedestrians' },
    moderate: { label: 'Moderate', hint: 'regular traffic' },
    high:     { label: 'High',     hint: 'busy road, more people' }
  };

  /* Fault model. These are simulation categories, not real diagnostics. */
  var FAULT_TYPES = {
    lamp: {
      label: 'Lamp failure', severity: 'high', drawsPower: false,
      description: 'The LED module gives no light. Simulated as no output and 0 W.'
    },
    driver: {
      label: 'Driver / electrical fault', severity: 'high', drawsPower: false,
      description: 'The driver tripped its protection. Simulated as no output and 0 W.'
    },
    comms: {
      label: 'Communication loss', severity: 'medium', drawsPower: true,
      description: 'The pole stopped answering. It keeps its last state (and keeps drawing power) but cannot receive commands.'
    }
  };

  /* Fixed order used by "Inject demo fault" so a live demo is repeatable. */
  var DEMO_FAULTS = [
    ['MS-02', 'lamp'], ['CL-03', 'comms'], ['MR-04', 'driver'],
    ['MS-04', 'lamp'], ['MR-01', 'comms'], ['CL-01', 'driver']
  ];

  var LOG_TYPES = {
    control: 'Lighting control',
    automation: 'Automation',
    energy: 'Energy optimisation',
    fault: 'Fault',
    system: 'System'
  };

  /* ------------------------------------------------------------------ *
   * Pure helpers
   * ------------------------------------------------------------------ */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function minuteOfDay(m) { return ((Math.floor(m) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY; }

  function dayNumber(m) { return Math.floor(m / MIN_PER_DAY) + 1; }

  function fmtTime(m) { var d = minuteOfDay(m); return pad(Math.floor(d / 60)) + ':' + pad(d % 60); }

  function fmtDuration(mins) {
    mins = Math.max(0, Math.round(mins));
    var h = Math.floor(mins / 60), m = mins % 60;
    if (!h) return m + ' min';
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  function parseTime(str) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  function clampPct(v) {
    v = Number(v);
    if (!isFinite(v)) return null;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  /** True when minute-of-day `m` falls in the on-window. Handles windows that cross midnight. */
  function isWithinSchedule(m, onTime, offTime) {
    m = minuteOfDay(m);
    if (onTime === offTime) return false;
    if (onTime < offTime) return m >= onTime && m < offTime;
    return m >= onTime || m < offTime;
  }

  /** Minutes in one day during which the schedule keeps lights on. */
  function scheduleOnMinutes(onTime, offTime) {
    if (onTime === offTime) return 0;
    return onTime < offTime ? offTime - onTime : MIN_PER_DAY - onTime + offTime;
  }

  /** Minutes from `now` until the clock next reads minute-of-day `target` (1..1440). */
  function minutesUntil(now, target) {
    var d = (minuteOfDay(target) - minuteOfDay(now) + MIN_PER_DAY) % MIN_PER_DAY;
    return d === 0 ? MIN_PER_DAY : d;
  }

  function faultInfo(light) { return light.fault ? FAULT_TYPES[light.fault.type] : null; }

  /** A light can take commands unless it has an active fault. */
  function isControllable(light) { return !light.fault; }

  /**
   * Modelled electrical power of one light, in watts.
   * Power = Rated power × Brightness / 100, or 0 when switched off.
   * Lamp and driver faults give 0 W; a communication loss keeps the last state.
   */
  function lightPowerW(light) {
    var f = faultInfo(light);
    if (f && !f.drawsPower) return 0;
    if (!light.on) return 0;
    return light.ratedW * light.brightness / 100;
  }

  function isLit(light) { return lightPowerW(light) > 0; }

  /** 'fault' | 'off' | 'dimmed' | 'on' */
  function lightStatus(light) {
    if (light.fault) return 'fault';
    if (!isLit(light)) return 'off';
    if (light.brightness < 100) return 'dimmed';
    return 'on';
  }

  function zoneById(id) {
    for (var i = 0; i < ZONES.length; i++) if (ZONES[i].id === id) return ZONES[i];
    return null;
  }

  /** Small deterministic PRNG (mulberry32) for the generated demo history. */
  function seeded(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function zeroZones() { var o = {}; ZONES.forEach(function (z) { o[z.id] = 0; }); return o; }
  function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }

  /** Totals derived from the light list. Never stored, always recalculated. */
  function summarize(lights) {
    var s = {
      total: lights.length, on: 0, off: 0, dimmed: 0, faults: 0, manual: 0,
      powerW: 0, maxW: 0, avgBrightness: 0, zones: []
    };
    var litBrightness = 0;
    lights.forEach(function (l) {
      var p = lightPowerW(l);
      s.powerW += p;
      s.maxW += l.ratedW;
      if (p > 0) { s.on++; litBrightness += l.brightness; } else s.off++;
      if (lightStatus(l) === 'dimmed') s.dimmed++;
      if (l.fault) s.faults++;
      if (l.mode === 'manual') s.manual++;
    });
    s.avgBrightness = s.on ? litBrightness / s.on : 0;
    s.zones = ZONES.map(function (z) {
      var zl = lights.filter(function (l) { return l.zoneId === z.id; });
      var zs = summarize.zone(zl);
      zs.id = z.id; zs.name = z.name; zs.code = z.code; zs.color = z.color;
      return zs;
    });
    return s;
  }
  summarize.zone = function (zl) {
    var r = { total: zl.length, on: 0, off: 0, faults: 0, powerW: 0, avgBrightness: 0 }, b = 0;
    zl.forEach(function (l) {
      var p = lightPowerW(l);
      r.powerW += p;
      if (p > 0) { r.on++; b += l.brightness; } else r.off++;
      if (l.fault) r.faults++;
    });
    r.avgBrightness = r.on ? b / r.on : 0;
    return r;
  };

  /* ------------------------------------------------------------------ *
   * Initial state
   * ------------------------------------------------------------------ */
  function newDay(index) {
    return {
      index: index,
      energyKWh: 0, baselineKWh: 0,
      zoneKWh: zeroZones(),
      hourlyKWh: zeros(24), hourlyBaselineKWh: zeros(24),
      minutes: 0
    };
  }

  function createInitialState(options) {
    var o = clone(DEFAULTS);
    options = options || {};
    Object.keys(options).forEach(function (k) { o[k] = clone(options[k]); });

    var lights = [];
    ZONES.forEach(function (z) {
      for (var i = 1; i <= o.polesPerZone; i++) {
        lights.push({
          id: z.code + '-' + pad(i),
          zoneId: z.id,
          pole: i,
          name: z.name + ' · Pole ' + i,
          on: false,
          brightness: 100,              // setpoint; kept while the light is off
          ratedW: o.ratedW,
          fault: null,                  // { type, alertId }
          mode: 'auto',                 // 'auto' follows schedule + policy, 'manual' = operator override
          lastChange: o.startMinute
        });
      }
    });

    var state = {
      minute: o.startMinute,
      running: true,
      tariff: o.tariff,
      schedule: o.schedule,
      policy: o.policy,
      ecoLevel: o.ecoLevel,
      adaptiveLevels: o.adaptiveLevels,
      activity: o.activity,
      liveWindow: o.liveWindow,
      logLimit: o.logLimit,
      lights: lights,
      alerts: [],
      log: [],
      live: [],
      day: newDay(dayNumber(o.startMinute)),
      pastDays: [],
      seq: { alert: 0, log: 0, demoFault: 0 },
      version: 0
    };
    return state;
  }

  /* ------------------------------------------------------------------ *
   * Simulation store
   * ------------------------------------------------------------------ */
  function createSimulation(options) {
    var state = createInitialState(options);
    var listeners = [];

    function emit(kind) {
      state.version++;
      for (var i = 0; i < listeners.length; i++) listeners[i](kind || 'change', state);
    }

    function log(type, message, target) {
      state.seq.log++;
      state.log.unshift({ id: state.seq.log, minute: state.minute, type: type, message: message, target: target || null });
      if (state.log.length > state.logLimit) state.log.length = state.logLimit;
    }

    function findLight(id) {
      for (var i = 0; i < state.lights.length; i++) if (state.lights[i].id === id) return state.lights[i];
      return null;
    }

    function findAlert(id) {
      for (var i = 0; i < state.alerts.length; i++) if (state.alerts[i].id === id) return state.alerts[i];
      return null;
    }

    function fail(reason) { return { ok: false, reason: reason }; }

    function blockedReason(light) {
      var f = faultInfo(light);
      return light.id + ' has a ' + f.label.toLowerCase() + '. Resolve the alert to control it again.';
    }

    /* ---------- automation ---------- */
    function autoBrightness(zoneId) {
      if (state.policy === 'eco') return state.ecoLevel;
      if (state.policy === 'adaptive') return state.adaptiveLevels[state.activity[zoneId]];
      return 100;
    }

    function scheduledOn(minute) {
      var s = state.schedule;
      return isWithinSchedule(minute, s.onTime, s.offTime);
    }

    /** Bring automatic, healthy lights in line with schedule + policy. Returns how many changed. */
    function syncAutomatic(filter) {
      var changed = 0, wantOn = state.schedule.enabled ? scheduledOn(state.minute) : null;
      state.lights.forEach(function (l) {
        if (l.mode !== 'auto' || l.fault) return;
        if (filter && !filter(l)) return;
        var on = wantOn === null ? l.on : wantOn;
        var b = autoBrightness(l.zoneId);
        if (l.on !== on || l.brightness !== b) {
          l.on = on; l.brightness = b; l.lastChange = state.minute; changed++;
        }
      });
      return changed;
    }

    function scheduleEvent(on) {
      var switched = 0, kept = 0, faulted = 0;
      state.lights.forEach(function (l) {
        if (l.fault) { faulted++; return; }
        if (l.mode !== 'auto') { kept++; return; }
        var b = autoBrightness(l.zoneId);
        if (l.on !== on || l.brightness !== b) { l.on = on; l.brightness = b; l.lastChange = state.minute; switched++; }
      });
      var msg = 'Schedule (' + fmtTime(on ? state.schedule.onTime : state.schedule.offTime) + ') switched ' +
        switched + ' light' + (switched === 1 ? '' : 's') + (on ? ' ON' : ' OFF');
      if (on && switched) msg += ' at ' + POLICIES[state.policy].short.toLowerCase() + ' brightness';
      var notes = [];
      if (kept) notes.push(kept + ' on manual override kept their state');
      if (faulted) notes.push(faulted + ' faulted skipped');
      if (notes.length) msg += ' · ' + notes.join(', ');
      log('automation', msg);
      return { switched: switched, kept: kept, faulted: faulted, on: on };
    }

    /* ---------- energy integration (one simulated minute) ---------- */
    function integrateMinute() {
      var s = summarize(state.lights);
      var baselineW = scheduledOn(state.minute) ? s.maxW : 0;
      var hour = Math.floor(minuteOfDay(state.minute) / 60);
      var kwh = s.powerW / 1000 / 60, base = baselineW / 1000 / 60;
      var d = state.day;
      d.energyKWh += kwh; d.baselineKWh += base;
      d.hourlyKWh[hour] += kwh; d.hourlyBaselineKWh[hour] += base;
      s.zones.forEach(function (z) { d.zoneKWh[z.id] += z.powerW / 1000 / 60; });
      d.minutes++;
      var zoneW = {};
      s.zones.forEach(function (z) { zoneW[z.id] = z.powerW; });
      state.live.push({ minute: state.minute, powerW: s.powerW, baselineW: baselineW, zoneW: zoneW });
      while (state.live.length > state.liveWindow) state.live.shift();
    }

    /* ------------------------------------------------------------------ *
     * Public API
     * ------------------------------------------------------------------ */
    var api = {
      ZONES: ZONES,

      getState: function () { return state; },

      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
      },

      light: findLight,
      summary: function () { return summarize(state.lights); },
      autoBrightness: autoBrightness,
      scheduledOnNow: function () { return scheduledOn(state.minute); },

      /** Next schedule action from the current simulated time, or null if the schedule is off. */
      nextScheduleAction: function () {
        var s = state.schedule;
        if (!s.enabled || s.onTime === s.offTime) return null;
        var toOn = minutesUntil(state.minute, s.onTime), toOff = minutesUntil(state.minute, s.offTime);
        return toOn <= toOff
          ? { on: true, at: s.onTime, inMinutes: toOn }
          : { on: false, at: s.offTime, inMinutes: toOff };
      },

      /* ---------- individual light controls ---------- */
      setLightPower: function (id, on, source) {
        var l = findLight(id);
        if (!l) return fail('Unknown light ' + id + '.');
        if (!isControllable(l)) return fail(blockedReason(l));
        on = !!on;
        var restored = false;
        if (on && l.brightness === 0) { l.brightness = 100; restored = true; }
        if (l.on === on && !restored) {
          // No state change, but an explicit operator command still pins the light (manual override)
          if (source !== 'automation' && l.mode !== 'manual') {
            l.mode = 'manual';
            log('control', id + ' held ' + (on ? 'ON' : 'OFF') + ' · manual override', id);
            emit();
          }
          return { ok: true, changed: false };
        }
        l.on = on;
        l.lastChange = state.minute;
        if (source !== 'automation') l.mode = 'manual';
        log('control', id + ' switched ' + (on ? 'ON at ' + l.brightness + '%' : 'OFF') +
          (restored ? ' (setpoint was 0 %, restored to 100 %)' : '') +
          (source !== 'automation' ? ' · manual override' : ''), id);
        emit();
        return { ok: true, changed: true };
      },

      /**
       * Change the brightness setpoint. The setpoint is kept while a light is off,
       * so power stays 0 W until it is switched on.
       * opts.log === false updates live (while a slider is dragged) without a log entry;
       * the final call passes opts.from so one entry records the whole drag.
       */
      setBrightness: function (id, pct, opts) {
        opts = opts || {};
        var l = findLight(id);
        if (!l) return fail('Unknown light ' + id + '.');
        if (!isControllable(l)) return fail(blockedReason(l));
        var v = clampPct(pct);
        if (v === null) return fail('Brightness must be a number from 0 to 100.');
        var from = opts.from !== undefined ? clampPct(opts.from) : l.brightness;
        var changed = l.brightness !== v;
        l.brightness = v;
        if (changed) l.lastChange = state.minute;
        if (opts.source !== 'automation' && (changed || opts.log !== false)) l.mode = 'manual';
        if (opts.log !== false && from !== v) {
          log('control', id + ' brightness set to ' + v + '% (was ' + from + '%)' +
            (l.on ? '' : ' · light is off, setpoint saved'), id);
        }
        if (changed || (opts.log !== false && from !== v)) emit();
        return { ok: true, changed: changed };
      },

      /** Hand a light back to automation (schedule + brightness policy). */
      setAuto: function (id) {
        var l = findLight(id);
        if (!l) return fail('Unknown light ' + id + '.');
        if (l.mode === 'auto') return { ok: true, changed: false };
        l.mode = 'auto';
        syncAutomatic(function (x) { return x === l; });
        log('automation', id + ' returned to automatic control', id);
        emit();
        return { ok: true, changed: true };
      },

      /* ---------- bulk controls ---------- */
      setZonePower: function (zoneId, on) {
        var z = zoneById(zoneId);
        if (!z) return fail('Unknown zone ' + zoneId + '.');
        return bulkPower(function (l) { return l.zoneId === zoneId; }, !!on, z.name);
      },

      setAllPower: function (on) {
        return bulkPower(function () { return true; }, !!on, 'All lights');
      },

      resumeAutomation: function () {
        var count = 0;
        state.lights.forEach(function (l) { if (l.mode === 'manual') { l.mode = 'auto'; count++; } });
        var changed = syncAutomatic();
        log('automation', 'Automation resumed: ' + count + ' override' + (count === 1 ? '' : 's') +
          ' cleared, ' + changed + ' light' + (changed === 1 ? '' : 's') + ' adjusted');
        emit();
        return { ok: true, cleared: count, changed: changed };
      },

      /* ---------- schedule ---------- */
      setSchedule: function (patch) {
        var s = state.schedule, next = { enabled: s.enabled, onTime: s.onTime, offTime: s.offTime };
        if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
        var keys = ['onTime', 'offTime'];
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i], raw = patch[k];
          if (raw === undefined) continue;
          var v = typeof raw === 'string' ? parseTime(raw) : (isFinite(raw) ? minuteOfDay(raw) : null);
          if (v === null) return fail((k === 'onTime' ? 'On' : 'Off') + ' time must be a valid time such as ' + (k === 'onTime' ? '18:00' : '06:00') + '.');
          next[k] = v;
        }
        if (next.onTime === next.offTime) return fail('On and off times must be different.');
        var msgs = [];
        if (next.enabled !== s.enabled) msgs.push('Automatic schedule ' + (next.enabled ? 'enabled' : 'disabled'));
        if (next.onTime !== s.onTime || next.offTime !== s.offTime) {
          msgs.push('Schedule set to ON ' + fmtTime(next.onTime) + ' · OFF ' + fmtTime(next.offTime));
        }
        if (!msgs.length) return { ok: true, changed: false };
        state.schedule = next;
        var changed = next.enabled ? syncAutomatic() : 0;
        log('automation', msgs.join('; ') + (changed ? ' · ' + changed + ' light' + (changed === 1 ? '' : 's') + ' adjusted now' : ''));
        emit();
        return { ok: true, changed: true };
      },

      /* ---------- brightness policy (Full / Eco / Adaptive) ---------- */
      setPolicy: function (policy) {
        if (!POLICIES[policy]) return fail('Unknown policy ' + policy + '.');
        if (state.policy === policy) return { ok: true, changed: false };
        state.policy = policy;
        var changed = syncAutomatic();
        var why = policy === 'eco' ? 'automatic lights dimmed to ' + state.ecoLevel + '%'
          : policy === 'adaptive' ? 'automatic lights follow simulated activity per zone'
          : 'automatic lights at 100%';
        log('energy', POLICIES[policy].label + ' enabled: ' + why + ' (' + changed + ' adjusted)');
        emit();
        return { ok: true, changed: true };
      },

      setActivity: function (zoneId, level) {
        var z = zoneById(zoneId);
        if (!z) return fail('Unknown zone ' + zoneId + '.');
        if (!ACTIVITY[level]) return fail('Unknown activity level ' + level + '.');
        if (state.activity[zoneId] === level) return { ok: true, changed: false };
        var prev = state.activity[zoneId];
        state.activity[zoneId] = level;
        var changed = 0;
        if (state.policy === 'adaptive') changed = syncAutomatic(function (l) { return l.zoneId === zoneId; });
        var msg = z.name + ' simulated activity ' + ACTIVITY[prev].label.toLowerCase() + ' → ' + ACTIVITY[level].label.toLowerCase();
        if (state.policy === 'adaptive') msg += ': target ' + state.adaptiveLevels[level] + '% (' + changed + ' light' + (changed === 1 ? '' : 's') + ' adjusted)';
        else msg += ' (Adaptive Lighting is off, no lights changed)';
        log('energy', msg, zoneId);
        emit();
        return { ok: true, changed: true };
      },

      setAdaptiveLevel: function (level, pct) {
        if (!ACTIVITY[level]) return fail('Unknown activity level ' + level + '.');
        var v = clampPct(pct);
        if (v === null || v < 10) return fail('Adaptive brightness must be between 10 % and 100 %.');
        if (state.adaptiveLevels[level] === v) return { ok: true, changed: false };
        state.adaptiveLevels[level] = v;
        var changed = state.policy === 'adaptive' ? syncAutomatic() : 0;
        log('energy', 'Adaptive target for ' + ACTIVITY[level].label.toLowerCase() + ' activity set to ' + v + '%' +
          (changed ? ' (' + changed + ' adjusted)' : ''));
        emit();
        return { ok: true, changed: true };
      },

      setEcoLevel: function (pct) {
        var v = clampPct(pct);
        if (v === null || v < 10 || v > 90) return fail('Eco brightness must be between 10 % and 90 %.');
        if (state.ecoLevel === v) return { ok: true, changed: false };
        state.ecoLevel = v;
        var changed = state.policy === 'eco' ? syncAutomatic() : 0;
        log('energy', 'Eco brightness set to ' + v + '%' + (changed ? ' (' + changed + ' adjusted)' : ''));
        emit();
        return { ok: true, changed: true };
      },

      /* ---------- tariff ---------- */
      setTariff: function (value) {
        var v = Number(value);
        if (!isFinite(v) || v <= 0 || v > 100) return fail('Tariff must be between ₹0.01 and ₹100 per kWh.');
        v = Math.round(v * 100) / 100;
        if (v === state.tariff) return { ok: true, changed: false };
        state.tariff = v;
        log('energy', 'Tariff set to ₹' + v.toFixed(2) + ' per kWh (costs recalculated)');
        emit();
        return { ok: true, changed: true };
      },

      /* ---------- faults and alerts ---------- */
      injectFault: function (id, type) {
        var l = findLight(id);
        if (!l) return fail('Unknown light ' + id + '.');
        if (!FAULT_TYPES[type]) return fail('Unknown fault type ' + type + '.');
        if (l.fault) return fail(id + ' already has an open fault.');
        state.seq.alert++;
        var alert = {
          id: 'A-' + String(state.seq.alert).padStart(3, '0'),
          lightId: id, zoneId: l.zoneId, type: type,
          severity: FAULT_TYPES[type].severity,
          detectedAt: state.minute, status: 'active', ackAt: null, resolvedAt: null
        };
        state.alerts.unshift(alert);
        l.fault = { type: type, alertId: alert.id };
        l.lastChange = state.minute;
        log('fault', FAULT_TYPES[type].label + ' detected on ' + id + ' (' + zoneById(l.zoneId).name + ') · severity ' + alert.severity, id);
        emit();
        return { ok: true, alert: alert };
      },

      /** Next fault from a fixed list, so demos are repeatable. */
      injectDemoFault: function () {
        for (var i = 0; i < DEMO_FAULTS.length; i++) {
          var k = (state.seq.demoFault + i) % DEMO_FAULTS.length, f = DEMO_FAULTS[k];
          var l = findLight(f[0]);
          if (l && !l.fault) {
            state.seq.demoFault = k + 1;
            return api.injectFault(f[0], f[1]);
          }
        }
        return fail('Every demo pole already has a fault. Resolve one first.');
      },

      acknowledgeAlert: function (alertId) {
        var a = findAlert(alertId);
        if (!a) return fail('Unknown alert ' + alertId + '.');
        if (a.status !== 'active') return fail('Alert ' + alertId + ' is already ' + a.status + '.');
        a.status = 'acknowledged'; a.ackAt = state.minute;
        log('fault', 'Operator acknowledged ' + FAULT_TYPES[a.type].label.toLowerCase() + ' on ' + a.lightId, a.lightId);
        emit();
        return { ok: true };
      },

      resolveAlert: function (alertId) {
        var a = findAlert(alertId);
        if (!a) return fail('Unknown alert ' + alertId + '.');
        if (a.status === 'resolved') return fail('Alert ' + alertId + ' is already resolved.');
        a.status = 'resolved'; a.resolvedAt = state.minute;
        if (!a.ackAt) a.ackAt = state.minute;
        var l = findLight(a.lightId);
        if (l && l.fault && l.fault.alertId === a.id) {
          l.fault = null; l.lastChange = state.minute;
          if (l.mode === 'auto') syncAutomatic(function (x) { return x === l; });
        }
        log('fault', FAULT_TYPES[a.type].label + ' on ' + a.lightId + ' resolved · light back in service' +
          (l ? ' (' + (isLit(l) ? 'on at ' + l.brightness + '%' : 'off') + ')' : ''), a.lightId);
        emit();
        return { ok: true };
      },

      /* ---------- clock ---------- */
      setRunning: function (running) {
        running = !!running;
        if (state.running === running) return;
        state.running = running;
        log('system', 'Simulated clock ' + (running ? 'resumed' : 'paused') + ' at ' + fmtTime(state.minute));
        emit();
      },

      /** Advance the simulated clock by n minutes (energy is integrated minute by minute). */
      tick: function (n) {
        n = Math.max(1, Math.floor(n || 1));
        for (var i = 0; i < n; i++) {
          integrateMinute();
          state.minute++;
          var m = minuteOfDay(state.minute);
          if (m === 0) {
            state.pastDays.push(state.day);
            if (state.pastDays.length > 30) state.pastDays.shift();
            state.day = newDay(dayNumber(state.minute));
            log('system', 'Day ' + state.day.index + ' started: today’s counters reset');
          }
          if (state.schedule.enabled && state.schedule.onTime !== state.schedule.offTime) {
            if (m === state.schedule.onTime) scheduleEvent(true);
            else if (m === state.schedule.offTime) scheduleEvent(false);
          }
        }
        emit('tick');
      },

      minutesUntil: function (target) { return minutesUntil(state.minute, target); },

      /* ---------- reset ---------- */
      reset: function () {
        var fresh = createInitialState(options);
        Object.keys(fresh).forEach(function (k) { state[k] = fresh[k]; });
        state.version = 0;
        boot();
        emit('reset');
      },

      /* ---------- analytics ---------- */
      analytics: function (period) { return analytics(state, period); }
    };

    function bulkPower(match, on, label) {
      var changed = 0, skipped = [];
      state.lights.forEach(function (l) {
        if (!match(l)) return;
        if (l.fault) { skipped.push(l.id); return; }
        var restore = on && l.brightness === 0;
        if (restore) l.brightness = 100;
        if (l.on !== on || restore) { l.on = on; l.lastChange = state.minute; changed++; }
        l.mode = 'manual';
      });
      log('control', label + ' switched ' + (on ? 'ON' : 'OFF') + ' by operator (' + changed + ' changed' +
        (skipped.length ? ', skipped faulted ' + skipped.join(', ') : '') + ') · manual override');
      emit();
      return { ok: true, changed: changed, skipped: skipped };
    }

    function boot() {
      syncAutomatic();
      // Seed the Live window with the hour before start, using the same rules,
      // so the chart is not empty. These samples are labelled simulated.
      var s = summarize(state.lights), zoneW = {};
      s.zones.forEach(function (z) { zoneW[z.id] = z.powerW; });
      for (var i = state.liveWindow; i >= 1; i--) {
        var t = state.minute - i;
        state.live.push({ minute: t, powerW: s.powerW, baselineW: scheduledOn(t) ? s.maxW : 0, zoneW: zoneW });
      }
      log('system', 'Simulation started on Day ' + dayNumber(state.minute) + ' at ' + fmtTime(state.minute) +
        '. All data on this dashboard is simulated.');
    }

    boot();
    return api;
  }

  /* ------------------------------------------------------------------ *
   * Analytics (pure function of state)
   * ------------------------------------------------------------------ */

  /**
   * Generated history for a day the simulation never ran.
   * Deterministic (same day → same numbers) and always flagged as generated.
   */
  function generatedDay(state, dayIndex) {
    var r = seeded(dayIndex * 9973 + 17);
    var onHours = scheduleOnMinutes(state.schedule.onTime, state.schedule.offTime) / 60;
    var zoneKWh = {}, energy = 0;
    ZONES.forEach(function (z) {
      var n = state.lights.filter(function (l) { return l.zoneId === z.id; });
      var rated = n.reduce(function (s, l) { return s + l.ratedW; }, 0);
      var factor = 0.62 + r() * 0.25;            // average share of rated power used
      var v = rated / 1000 * onHours * factor;
      zoneKWh[z.id] = v; energy += v;
    });
    var maxW = state.lights.reduce(function (s, l) { return s + l.ratedW; }, 0);
    return {
      index: dayIndex, energyKWh: energy,
      baselineKWh: maxW / 1000 * onHours,
      zoneKWh: zoneKWh, generated: true
    };
  }

  function analytics(state, period) {
    var out = {
      period: period, tariff: state.tariff,
      energyKWh: 0, baselineKWh: 0, zoneKWh: zeroZones(),
      labels: [], actual: [], baseline: [], generated: [],
      unit: 'kWh', hasGenerated: false, description: ''
    };

    if (period === 'live') {
      out.unit = 'W';
      out.description = 'Last ' + state.live.length + ' simulated minutes, sampled once per minute';
      state.live.forEach(function (p) {
        out.labels.push(fmtTime(p.minute));
        out.actual.push(Math.round(p.powerW));
        out.baseline.push(Math.round(p.baselineW));
        out.generated.push(false);
        out.energyKWh += p.powerW / 1000 / 60;
        out.baselineKWh += p.baselineW / 1000 / 60;
        ZONES.forEach(function (z) { out.zoneKWh[z.id] += (p.zoneW[z.id] || 0) / 1000 / 60; });
      });
    } else if (period === 'today') {
      var day = state.day, nowHour = Math.floor(minuteOfDay(state.minute) / 60);
      out.description = 'Day ' + day.index + ' so far (' + fmtDuration(day.minutes) + ' simulated), hourly totals';
      for (var h = 0; h < 24; h++) {
        out.labels.push(pad(h) + ':00');
        var future = h > nowHour;
        out.actual.push(future ? null : round4(day.hourlyKWh[h]));
        out.baseline.push(future ? null : round4(day.hourlyBaselineKWh[h]));
        out.generated.push(false);
      }
      out.energyKWh = day.energyKWh; out.baselineKWh = day.baselineKWh;
      ZONES.forEach(function (z) { out.zoneKWh[z.id] = day.zoneKWh[z.id]; });
    } else {
      var n = period === 'month' ? 30 : 7;
      var today = state.day.index;
      out.description = 'Last ' + n + ' days, daily totals';
      for (var k = n - 1; k >= 0; k--) {
        var idx = today - k, rec = null;
        if (k === 0) rec = state.day;
        else {
          for (var j = 0; j < state.pastDays.length; j++) if (state.pastDays[j].index === idx) rec = state.pastDays[j];
          if (!rec) rec = generatedDay(state, idx);
        }
        var gen = !!rec.generated;
        out.labels.push(k === 0 ? 'Today' : k + 'd ago');
        out.actual.push(round4(rec.energyKWh));
        out.baseline.push(round4(rec.baselineKWh));
        out.generated.push(gen);
        if (gen) out.hasGenerated = true;
        out.energyKWh += rec.energyKWh; out.baselineKWh += rec.baselineKWh;
        ZONES.forEach(function (z) { out.zoneKWh[z.id] += rec.zoneKWh[z.id]; });
      }
    }

    out.costRs = out.energyKWh * state.tariff;
    out.baselineCostRs = out.baselineKWh * state.tariff;
    out.savingsKWh = out.baselineKWh - out.energyKWh;
    out.savingsRs = out.savingsKWh * state.tariff;
    out.savingsPct = out.baselineKWh > 0 ? out.savingsKWh / out.baselineKWh * 100 : null;
    return out;
  }

  function round4(v) { return Math.round(v * 10000) / 10000; }

  return {
    MIN_PER_DAY: MIN_PER_DAY,
    ZONES: ZONES,
    DEFAULTS: DEFAULTS,
    POLICIES: POLICIES,
    ACTIVITY: ACTIVITY,
    FAULT_TYPES: FAULT_TYPES,
    LOG_TYPES: LOG_TYPES,
    DEMO_FAULTS: DEMO_FAULTS,
    createSimulation: createSimulation,
    createInitialState: createInitialState,
    summarize: summarize,
    lightPowerW: lightPowerW,
    lightStatus: lightStatus,
    isLit: isLit,
    isControllable: isControllable,
    isWithinSchedule: isWithinSchedule,
    scheduleOnMinutes: scheduleOnMinutes,
    minutesUntil: minutesUntil,
    minuteOfDay: minuteOfDay,
    dayNumber: dayNumber,
    fmtTime: fmtTime,
    fmtDuration: fmtDuration,
    parseTime: parseTime,
    clampPct: clampPct,
    zoneById: zoneById,
    analytics: analytics,
    generatedDay: generatedDay
  };
});
