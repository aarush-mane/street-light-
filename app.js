/*
 * LumenGrid UI layer.
 * Reads everything from the simulation model (window.LumenModel) and sends
 * every change back through the model's API. No metric is stored here.
 */
(function () {
  'use strict';
  var M = window.LumenModel;
  var sim = M.createSimulation();
  var ZONES = M.ZONES;

  /* ---------- view-only state (never affects lights) ---------- */
  var ui = {
    zone: 'all', status: 'all', selectedId: null, period: 'live', logFilter: 'all',
    demoDone: {}
  };

  var SECTIONS = [
    { id: 'street', label: 'Street' },
    { id: 'overview', label: 'Overview' },
    { id: 'lights', label: 'Lights' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'activity', label: 'Activity' }
  ];
  var STATUS_TEXT = { on: 'On', off: 'Off', dimmed: 'Dimmed', fault: 'Fault' };
  var STATUS_ICON = {
    on: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="currentColor"/></svg>',
    dimmed: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 2a4 4 0 0 1 0 8z" fill="currentColor"/></svg>',
    off: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    fault: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1 11 10H1z" fill="currentColor"/></svg>'
  };
  var POWER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8"/><path d="M17.7 6.8a8 8 0 1 1-11.4 0"/></svg>';
  var BULB_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<g class="rays" stroke-width="1.6"><path d="M12 0.5v1.5M3.5 4l1.1 1.1M20.5 4l-1.1 1.1M0.8 10.5h1.6M21.6 10.5h1.6"/></g>' +
      '<path class="glass-fill" d="M12 3.5a6.5 6.5 0 0 0-3.8 11.8c.6.5.9 1.2.9 2h5.8c0-.8.3-1.5.9-2A6.5 6.5 0 0 0 12 3.5z"/>' +
      '<path class="outline" d="M12 3.5a6.5 6.5 0 0 0-3.8 11.8c.6.5.9 1.2.9 2h5.8c0-.8.3-1.5.9-2A6.5 6.5 0 0 0 12 3.5z" stroke-width="1.4"/>' +
      '<path d="M9.3 19.5h5.4M10.3 22h3.4" stroke="#8a909d" stroke-width="1.6"/>' +
    '</svg>';

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function setText(el, v) { v = String(v); if (el && el._t !== v) { el._t = v; el.textContent = v; } }
  function setAttr(el, k, v) { v = String(v); if (el.getAttribute(k) !== v) el.setAttribute(k, v); }
  function fInt(v) { return Math.round(v).toLocaleString('en-IN'); }
  function fKWh(v) { return Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(3); }
  function fRs(v) { return (v < 0 ? '−₹' : '₹') + Math.abs(v).toFixed(2); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function zoneName(id) { return M.zoneById(id).name; }
  function stamp(minute) { return 'Day ' + M.dayNumber(minute) + ' ' + M.fmtTime(minute); }
  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- toasts (used sparingly: errors and important events) ---------- */
  function toast(msg, kind) {
    var box = $('toasts');
    var t = document.createElement('div');
    t.className = 'toast' + (kind === 'warn' ? ' warn' : '');
    t.innerHTML = '<span class="well" aria-hidden="true">' + (kind === 'warn' ? '⚠' : kind === 'ok' ? '✓' : 'ℹ') + '</span><span></span>';
    t.lastChild.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, 3200);
  }
  function report(res) {
    if (res && res.ok === false) toast(res.reason, 'warn');
    return res;
  }

  /* ---------- confirmation dialog ---------- */
  function confirmAction(title, message, okLabel) {
    var dlg = $('confirmDlg');
    if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm(title + '\n\n' + message));
    setText($('cfTitle'), title);
    setText($('cfMsg'), message);
    setText($('cfOk'), okLabel || 'Confirm');
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise(function (resolve) {
      dlg.addEventListener('close', function onClose() {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok');
      });
    });
  }

  /* ---------- smooth number tween for headline values ---------- */
  var tweens = new Map(), tweenRaf = 0;
  function setNum(el, to, fmt) {
    if (el._cur === undefined || reduceMotion) { el._cur = to; el._to = to; el.textContent = fmt(to); return; }
    if (el._to === to) return;
    el._to = to;
    tweens.set(el, { from: el._cur, to: to, t0: performance.now(), fmt: fmt });
    if (!tweenRaf) tweenRaf = requestAnimationFrame(tweenStep);
  }
  function tweenStep(now) {
    tweenRaf = 0;
    tweens.forEach(function (tw, el) {
      var p = Math.min(1, (now - tw.t0) / 500), e = 1 - Math.pow(1 - p, 3);
      el._cur = tw.from + (tw.to - tw.from) * e;
      el.textContent = tw.fmt(el._cur);
      if (p >= 1) tweens.delete(el);
    });
    if (tweens.size) tweenRaf = requestAnimationFrame(tweenStep);
  }

  /* ---------- gauge ---------- */
  var GAUGE_TICKS = 56, G_START = 200, G_SWEEP = 220, GCX = 160, GCY = 150;
  var gaugeTicks = [], gFrac = 0, gTarget = -1, gFrom = 0, gT0 = 0, gRaf = 0, gLastActive = -2;
  function polar(r, deg) { var a = deg * Math.PI / 180; return [GCX + r * Math.cos(a), GCY - r * Math.sin(a)]; }
  function buildGauge(maxW) {
    var html = '', i;
    for (i = 0; i < GAUGE_TICKS; i++) {
      var deg = G_START - (i / (GAUGE_TICKS - 1)) * G_SWEEP, p1 = polar(112, deg), p2 = polar(140, deg);
      html += '<line class="tick" x1="' + p1[0].toFixed(1) + '" y1="' + p1[1].toFixed(1) + '" x2="' + p2[0].toFixed(1) + '" y2="' + p2[1].toFixed(1) + '"/>';
    }
    for (i = 0; i <= 40; i++) {
      var d = G_START - (i / 40) * G_SWEEP, q = polar(96, d);
      html += '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="' + (i % 10 === 0 ? 1.8 : 1) + '" style="fill:var(--faint)"/>';
    }
    var tx = function (p, dy, s) { return '<text x="' + p[0].toFixed(1) + '" y="' + (p[1] + dy).toFixed(1) + '" font-size="10" style="fill:var(--muted)" text-anchor="middle">' + s + '</text>'; };
    html += tx(polar(80, G_START), 4, '0') + tx(polar(80, G_START - G_SWEEP / 2), 10, fInt(maxW / 2) + ' W') + tx(polar(80, G_START - G_SWEEP), 4, fInt(maxW));
    var n1 = polar(108, G_START), n2 = polar(150, G_START);
    html += '<g id="gNeedle"><line x1="' + n1[0].toFixed(1) + '" y1="' + n1[1].toFixed(1) + '" x2="' + n2[0].toFixed(1) + '" y2="' + n2[1].toFixed(1) + '" style="stroke:var(--text)" stroke-width="3" stroke-linecap="round"/><circle cx="' + n2[0].toFixed(1) + '" cy="' + n2[1].toFixed(1) + '" r="6" style="fill:var(--bg);stroke:var(--text)" stroke-width="3"/></g>';
    $('gaugeSvg').innerHTML = html;
    gaugeTicks = $('gaugeSvg').querySelectorAll('.tick');
  }
  function drawGauge(frac) {
    var active = frac > 0.001 ? Math.round(frac * (GAUGE_TICKS - 1)) : -1;
    if (active !== gLastActive) {
      gLastActive = active;
      for (var i = 0; i < gaugeTicks.length; i++) {
        var on = i <= active;
        gaugeTicks[i].classList.toggle('on', on);
        gaugeTicks[i].classList.toggle('hot', on && i > GAUGE_TICKS * 0.75);
      }
    }
    $('gNeedle').style.transform = 'rotate(' + (frac * G_SWEEP).toFixed(2) + 'deg)';
  }
  function setGauge(frac) {
    frac = Math.max(0, Math.min(1, frac));
    if (frac === gTarget) return;
    gTarget = frac; gFrom = gFrac; gT0 = performance.now();
    if (reduceMotion) { gFrac = frac; drawGauge(frac); return; }
    if (!gRaf) gRaf = requestAnimationFrame(gaugeStep);
  }
  function gaugeStep(now) {
    var p = Math.min(1, (now - gT0) / 650), e = 1 - Math.pow(1 - p, 3);
    gFrac = gFrom + (gTarget - gFrom) * e;
    drawGauge(gFrac);
    gRaf = p < 1 ? requestAnimationFrame(gaugeStep) : 0;
  }

  /* ================================================================== *
   * Static structure built once
   * ================================================================== */
  function buildNav() {
    var html = SECTIONS.map(function (s) {
      return '<a href="#' + s.id + '" data-nav="' + s.id + '">' + s.label + (s.id === 'activity' ? ' <span class="count" data-alert-count hidden></span>' : '') + '</a>';
    }).join('');
    document.querySelectorAll('[data-navpill]').forEach(function (p) { p.innerHTML = html; });
  }

  function buildZoneFilters() {
    var html = '<button type="button" data-zone="all" aria-pressed="true">All zones</button>' +
      ZONES.map(function (z) { return '<button type="button" data-zone="' + z.id + '" aria-pressed="false">' + esc(z.name) + '</button>'; }).join('');
    document.querySelectorAll('[data-zone-filter]').forEach(function (g) { g.innerHTML = html; });
  }

  function buildZoneSummaries() {
    $('zoneSums').innerHTML = ZONES.map(function (z) {
      return '<button type="button" class="zone-sum" data-zone-sum="' + z.id + '" aria-pressed="false" style="--zc:' + z.color + '">' +
        '<span class="zh"><b><i aria-hidden="true"></i>' + esc(z.name) + '</b><span class="tag" data-f="mode"></span></span>' +
        '<dl>' +
          '<div><dt>On</dt><dd data-f="on">0</dd></div><div><dt>Off</dt><dd data-f="off">0</dd></div><div><dt>Faults</dt><dd data-f="faults">0</dd></div>' +
          '<div><dt>Power</dt><dd data-f="power">0 W</dd></div><div><dt>Avg brightness</dt><dd data-f="avg">–</dd></div><div><dt>Lights</dt><dd data-f="total">4</dd></div>' +
        '</dl>' +
        '<span class="zf" data-f="hint">Select to filter street and lights</span>' +
      '</button>';
    }).join('');
  }

  function buildActivityRows() {
    $('activityRows').innerHTML = ZONES.map(function (z) {
      return '<div class="act-row" style="--zc:' + z.color + '">' +
        '<span class="zn"><i aria-hidden="true"></i>' + esc(z.name) + '</span>' +
        '<div class="seg sm" role="radiogroup" aria-label="Simulated activity on ' + esc(z.name) + '">' +
          Object.keys(M.ACTIVITY).map(function (k) {
            return '<button type="button" role="radio" data-activity="' + k + '" data-zone="' + z.id + '" aria-checked="false">' + M.ACTIVITY[k].label + '</button>';
          }).join('') +
        '</div>' +
        '<span class="tgt" data-target="' + z.id + '">–</span>' +
      '</div>';
    }).join('');
  }

  function buildLightCards() {
    var st = sim.getState(), html = '';
    ZONES.forEach(function (z) {
      html += '<section class="zone" data-zone-sec="' + z.id + '" style="--zc:' + z.color + '" aria-label="' + esc(z.name) + '">' +
        '<div class="zone-head">' +
          '<div class="zone-name"><span class="well"><i></i></span><div><h3>' + esc(z.name) + '</h3><p data-zinfo="' + z.id + '"></p></div></div>' +
          '<div class="zone-actions">' +
            '<button class="btn btn-sm" type="button" data-act="zone-on" data-zone="' + z.id + '">Zone on</button>' +
            '<button class="btn btn-sm" type="button" data-act="zone-off" data-zone="' + z.id + '">Zone off</button>' +
          '</div>' +
        '</div><div class="grid">';
      st.lights.filter(function (l) { return l.zoneId === z.id; }).forEach(function (l) {
        html +=
          '<article class="neu light" id="card-' + l.id + '" data-id="' + l.id + '" aria-labelledby="t-' + l.id + '">' +
            '<div class="light-top"><div class="bulb">' + BULB_SVG + '</div>' +
              '<div class="badges"><span class="badge" data-r="badge"></span><span class="tag" data-r="mode"></span></div></div>' +
            '<h4 id="t-' + l.id + '">' + l.id + '</h4>' +
            '<p class="sub">' + esc(z.name) + ' · Pole ' + l.pole + '</p>' +
            '<div class="slider-row">' +
              '<label class="lbl" for="rng-' + l.id + '"><span>Brightness</span><b data-r="pct"></b></label>' +
              '<input id="rng-' + l.id + '" type="range" min="0" max="100" step="5" data-r="range" data-id="' + l.id + '">' +
            '</div>' +
            '<div class="meta">' +
              '<span class="watts" data-r="watts" aria-label="Power draw"></span>' +
              '<label class="switch" data-r="switch">' +
                '<input type="checkbox" data-r="toggle" data-id="' + l.id + '" aria-label="Power for ' + l.id + '">' +
                '<span class="txt" data-r="ttxt">Off</span><span class="knob">' + POWER_ICON + '</span>' +
              '</label>' +
            '</div>' +
            '<p class="fault-note" data-r="fault" hidden></p>' +
            '<div class="card-foot">' +
              '<button class="link-btn" type="button" data-act="details" data-id="' + l.id + '">Details</button>' +
              '<button class="link-btn" type="button" data-act="auto" data-id="' + l.id + '" hidden>Return to auto</button>' +
            '</div>' +
          '</article>';
      });
      html += '</div></section>';
    });
    $('zones').innerHTML = html;
  }

  /* ---------- pole details panel ---------- */
  var panelFor = null;
  function buildPanel(id) {
    var l = sim.light(id), z = M.zoneById(l.zoneId), p = $('polePanel');
    var faultOpts = Object.keys(M.FAULT_TYPES).map(function (k) { return '<option value="' + k + '">' + esc(M.FAULT_TYPES[k].label) + '</option>'; }).join('');
    p.innerHTML =
      '<div class="pp-head">' +
        '<div><h3 id="pp-title">' + l.id + ' <span class="badge" data-r="badge"></span> <span class="tag" data-r="mode"></span></h3>' +
        '<p>' + esc(z.name) + ' · Pole ' + l.pole + ' · rated ' + l.ratedW + ' W · simulated</p></div>' +
        '<button class="btn btn-sm" type="button" data-act="close" aria-label="Close details for ' + l.id + '">Close ✕</button>' +
      '</div>' +
      '<div class="pp-fault" data-r="faultbox" hidden></div>' +
      '<div class="pp-facts">' +
        '<div class="fact"><small>State</small><b data-r="state"></b></div>' +
        '<div class="fact"><small>Brightness setpoint</small><b data-r="pct"></b></div>' +
        '<div class="fact"><small>Power draw</small><b data-r="watts"></b></div>' +
        '<div class="fact"><small>Control</small><b data-r="ctl"></b></div>' +
        '<div class="fact"><small>Health</small><b data-r="health"></b></div>' +
        '<div class="fact"><small>Last change</small><b data-r="last"></b></div>' +
      '</div>' +
      '<div class="pp-controls">' +
        '<div class="pp-row"><span style="font-size:.84rem;font-weight:500">Power</span>' +
          '<label class="switch" data-r="switch"><input type="checkbox" data-r="toggle" data-id="' + l.id + '" aria-label="Power for ' + l.id + '"><span class="txt" data-r="ttxt">Off</span><span class="knob">' + POWER_ICON + '</span></label></div>' +
        '<div><label class="slider-row lbl" for="pp-rng" style="display:flex;justify-content:space-between;font-size:.74rem;color:var(--muted)"><span>Brightness setpoint</span><b data-r="pct2" style="color:var(--text)"></b></label>' +
          '<input id="pp-rng" type="range" min="0" max="100" step="5" data-r="range" data-id="' + l.id + '"></div>' +
        '<p class="reason" data-r="reason"></p>' +
        '<div class="pp-row">' +
          '<button class="btn btn-sm" type="button" data-act="auto" data-id="' + l.id + '">Return to automatic</button>' +
          '<span class="pp-sim" data-r="simfault"><label for="pp-ftype">Simulate</label><select id="pp-ftype">' + faultOpts + '</select>' +
          '<button class="btn btn-sm btn-danger" type="button" data-act="fault" data-id="' + l.id + '">Inject fault</button></span>' +
        '</div>' +
      '</div>';
    panelFor = id;
  }

  /* ================================================================== *
   * Rendering (idempotent; driven by model changes)
   * ================================================================== */
  var renderQueued = false, lastChartAt = 0, chartTimer = 0;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () { renderQueued = false; render(); });
  }

  function lightControlsReason(l) {
    if (l.fault) {
      var f = M.FAULT_TYPES[l.fault.type];
      return l.fault.type === 'comms'
        ? 'Controls locked: no communication with ' + l.id + '. It keeps its last state until the alert is resolved.'
        : 'Controls locked: ' + f.label.toLowerCase() + '. Resolve the alert to restore control.';
    }
    if (!l.on) return 'Light is off, so it draws 0 W. The brightness setpoint is kept for when it is switched on.';
    if (l.mode === 'auto') return 'Automatic: follows the schedule and the ' + M.POLICIES[sim.getState().policy].label.toLowerCase() + ' policy. Any change here becomes a manual override.';
    return 'Manual override: automation will not change this light until you return it to automatic.';
  }

  function paintLightControls(root, l) {
    var st = M.lightStatus(l), w = Math.round(M.lightPowerW(l)), locked = !!l.fault;
    var badge = root.querySelector('[data-r=badge]');
    var bk = st + '|' + (l.fault ? l.fault.type : '');
    if (badge._k !== bk) {
      badge._k = bk;
      badge.className = 'badge ' + st;
      badge.innerHTML = STATUS_ICON[st] + esc(st === 'fault' ? 'Fault' : STATUS_TEXT[st]);
    }
    var mode = root.querySelector('[data-r=mode]');
    setText(mode, l.mode === 'manual' ? 'Manual' : 'Auto');
    mode.className = 'tag ' + (l.mode === 'manual' ? 'manual' : 'sim');
    var range = root.querySelector('[data-r=range]');
    if (!range._dragging && +range.value !== l.brightness) range.value = l.brightness;
    range.style.setProperty('--v', l.brightness + '%');
    range.classList.toggle('off-setpoint', !M.isLit(l));
    range.disabled = locked;
    setAttr(range, 'aria-valuetext', l.brightness + '% setpoint' + (l.on ? '' : ', light off'));
    root.querySelectorAll('[data-r=pct],[data-r=pct2]').forEach(function (el) { setText(el, l.brightness + '%'); });
    var watts = root.querySelector('[data-r=watts]');
    if (watts._t !== w) { watts._t = w; watts.innerHTML = w + ' <small>W</small>'; }
    var tog = root.querySelector('[data-r=toggle]');
    tog.checked = l.on;
    tog.disabled = locked;
    root.querySelector('[data-r=switch]').classList.toggle('disabled', locked);
    setText(root.querySelector('[data-r=ttxt]'), l.on ? 'On' : 'Off');
  }

  function renderCards(state) {
    var visible = 0;
    state.lights.forEach(function (l) {
      var card = $('card-' + l.id);
      if (!card) return;
      var lit = M.isLit(l), st = M.lightStatus(l), wasOn = card.classList.contains('is-on');
      card.style.setProperty('--b', (l.brightness / 100).toFixed(2));
      card.classList.toggle('is-on', lit);
      card.classList.toggle('is-fault', !!l.fault);
      card.classList.toggle('selected', ui.selectedId === l.id);
      if (lit && !wasOn && card._seen && !reduceMotion) { card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop'); }
      card._seen = true;
      paintLightControls(card, l);
      var fn = card.querySelector('[data-r=fault]');
      fn.hidden = !l.fault;
      if (l.fault) setText(fn, '⚠ ' + M.FAULT_TYPES[l.fault.type].label + ' · controls locked until resolved');
      card.querySelector('[data-act=auto]').hidden = l.mode !== 'manual';
      var show = (ui.zone === 'all' || ui.zone === l.zoneId) && (ui.status === 'all' || ui.status === st);
      card.hidden = !show;
      if (show) visible++;
    });
    ZONES.forEach(function (z) {
      var sec = document.querySelector('[data-zone-sec="' + z.id + '"]');
      var any = state.lights.some(function (l) { return l.zoneId === z.id && !$('card-' + l.id).hidden; });
      sec.hidden = !any;
    });
    setText($('filterInfo'), 'Showing ' + visible + ' of ' + state.lights.length + ' lights' +
      (ui.zone !== 'all' ? ' · ' + zoneName(ui.zone) : '') + (ui.status !== 'all' ? ' · ' + STATUS_TEXT[ui.status].toLowerCase() : ''));
    $('lightsEmpty').hidden = visible > 0;
  }

  function renderPanel(state) {
    var p = $('polePanel');
    if (!ui.selectedId) { if (!p.hidden) { p.hidden = true; p.innerHTML = ''; panelFor = null; } return; }
    if (panelFor !== ui.selectedId) buildPanel(ui.selectedId);
    p.hidden = false;
    var l = sim.light(ui.selectedId);
    paintLightControls(p, l);
    var f = l.fault ? M.FAULT_TYPES[l.fault.type] : null;
    setText(p.querySelector('[data-r=state]'), M.isLit(l) ? 'On' : l.on && f ? 'On (no output)' : l.on ? 'On at 0%' : 'Off');
    setText(p.querySelector('[data-r=ctl]'), l.mode === 'manual' ? 'Manual override' : 'Automatic');
    setText(p.querySelector('[data-r=health]'), f ? f.label : 'Healthy');
    setText(p.querySelector('[data-r=last]'), stamp(l.lastChange));
    setText(p.querySelector('[data-r=reason]'), lightControlsReason(l));
    p.querySelector('[data-act=auto]').hidden = l.mode !== 'manual';
    p.querySelector('[data-r=simfault]').hidden = !!l.fault;
    var box = p.querySelector('[data-r=faultbox]');
    box.hidden = !f;
    if (f) {
      var a = state.alerts.filter(function (x) { return x.id === l.fault.alertId; })[0];
      var key = a.id + a.status;
      if (box._k !== key) {
        box._k = key;
        box.innerHTML = '<div><b>⚠ ' + esc(f.label) + '</b> · severity ' + a.severity + ' · ' + a.status + '<br><span class="muted">' + esc(f.description) + '</span></div>' +
          '<div class="ai-btns">' +
          (a.status === 'active' ? '<button class="btn btn-sm" type="button" data-act="ack" data-alert="' + a.id + '">Acknowledge</button>' : '') +
          '<button class="btn btn-sm btn-primary" type="button" data-act="resolve" data-alert="' + a.id + '">Mark resolved</button></div>';
      }
    } else box._k = null;
  }

  function renderOverview(state, sum) {
    setText($('kTotal'), sum.total);
    setText($('kTotalSub'), ZONES.length + ' zones · ' + (sum.total / ZONES.length) + ' poles each');
    setText($('kOn'), sum.on);
    setText($('kOff'), sum.off);
    setText($('kOnSub'), sum.dimmed + ' dimmed · ' + plural(sum.manual, 'manual override'));
    var openAlerts = state.alerts.filter(function (a) { return a.status !== 'resolved'; });
    var unacked = openAlerts.filter(function (a) { return a.status === 'active'; }).length;
    setText($('kFaults'), sum.faults);
    setText($('kFaultSub'), sum.faults ? (unacked ? unacked + ' not acknowledged' : 'All acknowledged') : 'All lights healthy');
    $('kFaultCard').classList.toggle('alert', sum.faults > 0);
    setNum($('kPower'), sum.powerW, fInt);
    setText($('kPowerSub'), Math.round(sum.powerW / sum.maxW * 100) + '% of ' + fInt(sum.maxW) + ' W rated');
    setNum($('gPower'), sum.powerW, fInt);
    setGauge(sum.powerW / sum.maxW);
    setText($('gaugeChip'), sum.on ? 'avg ' + Math.round(sum.avgBrightness) + '% on ' + plural(sum.on, 'lit pole') : 'no lights on');

    var banner = $('faultBanner');
    banner.hidden = !openAlerts.length;
    if (openAlerts.length) {
      setText($('faultBannerText'), plural(openAlerts.length, 'light') + (openAlerts.length === 1 ? ' needs' : ' need') + ' attention: ' +
        openAlerts.map(function (a) { return a.lightId + ' (' + M.FAULT_TYPES[a.type].label + ', ' + a.status + ')'; }).join(', '));
    }

    $('btnEco').setAttribute('aria-pressed', state.policy === 'eco' ? 'true' : 'false');
    setText($('ecoTileSub'), state.policy === 'eco' ? 'Tap to return to full' : 'Auto lights at ' + state.ecoLevel + '%');

    var t = sim.analytics('today');
    setText($('todaySub'), 'Day ' + state.day.index + ' · ' + M.fmtDuration(state.day.minutes) + ' simulated so far');
    setNum($('tEnergy'), t.energyKWh, fKWh);
    setText($('tCost'), fRs(t.costRs));
    setText($('tTariff'), 'at ₹' + state.tariff.toFixed(2) + ' per kWh');
    setNum($('tBase'), t.baselineKWh, fKWh);
    setNum($('tSaved'), t.savingsKWh, fKWh);
    var row = $('tSavedRow'), neg = t.savingsKWh < -1e-9;
    row.classList.toggle('neg', neg);
    var pct = t.savingsPct;
    setText($('tSavedSub'), pct === null ? 'no scheduled hours yet today'
      : neg ? Math.abs(pct).toFixed(0) + '% more than baseline (' + fRs(t.savingsRs) + ')'
      : pct.toFixed(0) + '% less · ' + fRs(t.savingsRs) + ' saved');
    var w = pct === null ? 0 : Math.max(0, Math.min(100, pct));
    $('tMeter').style.width = w.toFixed(1) + '%';
    setAttr($('tMeterWrap'), 'aria-label', 'Savings ' + (pct === null ? 'not available' : pct.toFixed(0) + ' percent of baseline'));

    sum.zones.forEach(function (z) {
      var b = document.querySelector('[data-zone-sum="' + z.id + '"]');
      setText(b.querySelector('[data-f=on]'), z.on);
      setText(b.querySelector('[data-f=off]'), z.off);
      var fe = b.querySelector('[data-f=faults]');
      setText(fe, z.faults);
      fe.classList.toggle('bad', z.faults > 0);
      setText(b.querySelector('[data-f=power]'), fInt(z.powerW) + ' W');
      setText(b.querySelector('[data-f=avg]'), z.on ? Math.round(z.avgBrightness) + '%' : '–');
      setText(b.querySelector('[data-f=total]'), z.total);
      var act = state.policy === 'adaptive' ? M.ACTIVITY[state.activity[z.id]].label + ' activity' : M.POLICIES[state.policy].short;
      setText(b.querySelector('[data-f=mode]'), act);
      b.setAttribute('aria-pressed', ui.zone === z.id ? 'true' : 'false');
      setText(b.querySelector('[data-f=hint]'), ui.zone === z.id ? 'Filtered · select again to show all zones' : 'Select to filter street and lights');
      var zinfo = document.querySelector('[data-zinfo="' + z.id + '"]');
      setText(zinfo, z.on + '/' + z.total + ' on · ' + fInt(z.powerW) + ' W' + (z.faults ? ' · ' + plural(z.faults, 'fault') : ''));
    });
  }

  function renderAutomation(state, sum) {
    var s = state.schedule;
    $('schedToggle').checked = s.enabled;
    setText($('schedToggleTxt'), s.enabled ? 'On' : 'Off');
    if (document.activeElement !== $('schedOn')) $('schedOn').value = M.fmtTime(s.onTime);
    if (document.activeElement !== $('schedOff')) $('schedOff').value = M.fmtTime(s.offTime);
    var next = sim.nextScheduleAction();
    var nl = $('schedNext');
    var key = s.enabled + '|' + (next ? next.on + next.at + next.inMinutes : '') + '|' + sim.scheduledOnNow();
    if (nl._k !== key) {
      nl._k = key;
      nl.innerHTML = s.enabled && next
        ? '<span class="tag ' + (sim.scheduledOnNow() ? 'amber' : 'sim') + '">' + (sim.scheduledOnNow() ? 'Inside on-window' : 'Outside on-window') + '</span>' +
          '<span>Next: lights <b>' + (next.on ? 'ON' : 'OFF') + '</b> at <b>' + M.fmtTime(next.at) + '</b> (in ' + M.fmtDuration(next.inMinutes) + ' sim time)</span>'
        : '<span class="tag warn">Schedule off</span><span>Automatic lights keep their current on/off state. Brightness still follows the policy.</span>';
    }
    var manual = state.lights.filter(function (l) { return l.mode === 'manual'; });
    setText($('overrideInfo'), manual.length
      ? plural(manual.length, 'light') + ' on manual override: ' + manual.map(function (l) { return l.id; }).join(', ')
      : 'No manual overrides. All lights are automatic.');
    $('btnResume').disabled = !manual.length;
    setAttr($('btnResume'), 'title', manual.length ? 'Return every light to automatic control' : 'Nothing to resume');

    document.querySelectorAll('#policySeg [data-policy]').forEach(function (b) {
      setAttr(b, 'aria-checked', b.getAttribute('data-policy') === state.policy ? 'true' : 'false');
      b.tabIndex = b.getAttribute('data-policy') === state.policy ? 0 : -1;
    });
    var ex = $('policyExplain'), ek = state.policy + state.ecoLevel + JSON.stringify(state.adaptiveLevels);
    if (ex._k !== ek) {
      ex._k = ek;
      ex.innerHTML = state.policy === 'full' ? '<b>Full:</b> automatic lights run at 100% while switched on. This matches the baseline, so it saves nothing.'
        : state.policy === 'eco' ? '<b>Eco:</b> automatic lights run at ' + state.ecoLevel + '%, which uses about ' + (100 - state.ecoLevel) + '% less energy than the baseline while on.'
        : '<b>Adaptive:</b> each zone’s brightness follows its simulated activity: low → ' + state.adaptiveLevels.low + '%, moderate → ' + state.adaptiveLevels.moderate + '%, high → ' + state.adaptiveLevels.high + '%. Manual overrides are left alone.';
    }
    $('ecoBox').hidden = state.policy !== 'eco';
    $('adaptiveBox').hidden = state.policy !== 'adaptive';
    if (document.activeElement !== $('ecoLevel')) $('ecoLevel').value = state.ecoLevel;
    document.querySelectorAll('[data-level]').forEach(function (inp) {
      if (document.activeElement !== inp) inp.value = state.adaptiveLevels[inp.getAttribute('data-level')];
    });
    ZONES.forEach(function (z) {
      document.querySelectorAll('[data-activity][data-zone="' + z.id + '"]').forEach(function (b) {
        var on = b.getAttribute('data-activity') === state.activity[z.id];
        setAttr(b, 'aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      setText(document.querySelector('[data-target="' + z.id + '"]'), sim.autoBrightness(z.id) + '%');
    });
  }

  function renderAnalytics(state, sum, force) {
    var a = sim.analytics(ui.period);
    var label = { live: 'Live', today: 'Today', week: 'Last 7 days', month: 'Last 30 days' }[ui.period];
    setText($('periodDesc'), label + ': ' + a.description);
    setNum($('aPower'), sum.powerW, fInt);
    setText($('aEnergy'), fKWh(a.energyKWh));
    setText($('aEnergySub'), ui.period === 'live' ? 'last ' + state.live.length + ' sim minutes' : label.toLowerCase());
    setText($('aCost'), fRs(a.costRs));
    setText($('aCostSub'), fKWh(a.energyKWh) + ' kWh × ₹' + state.tariff.toFixed(2));
    setText($('aBase'), fKWh(a.baselineKWh));
    setText($('aBaseSub'), fRs(a.baselineCostRs) + ' at tariff');
    setText($('aSaved'), fKWh(a.savingsKWh));
    var card = $('aSavedCard'), neg = a.savingsKWh < -1e-9;
    card.classList.toggle('good', a.savingsKWh > 1e-9);
    card.classList.toggle('bad', neg);
    setText($('aSavedSub'), a.savingsPct === null ? 'no baseline hours in range'
      : (neg ? Math.abs(a.savingsPct).toFixed(1) + '% above baseline · ' : a.savingsPct.toFixed(1) + '% · ') + fRs(a.savingsRs));
    if (document.activeElement !== $('tariff')) $('tariff').value = state.tariff;
    $('genLegend').hidden = !a.hasGenerated;
    $('baseSwatch').className = ui.period === 'live' ? 'dash' : 'base-bar';
    setText($('baseLegend'), ui.period === 'live' ? 'Baseline (dashed)' : 'Baseline (grey bars)');
    setText($('c1Title'), ui.period === 'live' ? 'Power over time' : 'Energy over time');
    setText($('c1Sub'), ui.period === 'live' ? 'Watts each simulated minute · actual vs baseline'
      : ui.period === 'today' ? 'kWh per simulated hour · actual vs baseline' : 'kWh per day · actual vs baseline');
    setText($('c2Sub'), 'kWh in ' + label.toLowerCase() + ' · tooltip shows ₹ at current tariff');
    setText($('dataNote'), a.hasGenerated
      ? 'Hatched bars are generated demo history (deterministic, recomputed from the current schedule). They are not measurements. "Today" comes from this running simulation; no real meter is connected.'
      : 'All values in this range come from this running simulation. They are simulated, not measured by real hardware.');
    var top = ZONES.map(function (z) { return z.name + ' ' + fKWh(a.zoneKWh[z.id]) + ' kWh'; }).join(', ');
    setText($('c1Summary'), label + ': actual ' + fKWh(a.energyKWh) + ' kWh against a baseline of ' + fKWh(a.baselineKWh) + ' kWh.');
    setText($('c2Summary'), 'Energy by zone, ' + label.toLowerCase() + ': ' + top + '.');

    // Charts: redraw at most ~4×/s while fast-forwarding, every change otherwise
    if (!charts.available) return;
    var now = performance.now(), gap = ffRemaining > 0 ? 250 : 0;
    if (force || now - lastChartAt >= gap) {
      lastChartAt = now;
      charts.update(a, { dark: isDark(), instant: ffRemaining > 0 || reduceMotion });
    } else if (!chartTimer) {
      chartTimer = setTimeout(function () { chartTimer = 0; requestRender(); }, gap);
    }
  }

  var alertKey = null, logKey = null;
  function renderActivity(state) {
    var counts = { active: 0, acknowledged: 0, resolved: 0 };
    state.alerts.forEach(function (a) { counts[a.status]++; });
    var open = counts.active + counts.acknowledged;
    setText($('alertCounts'), state.alerts.length ? counts.active + ' active · ' + counts.acknowledged + ' acknowledged · ' + counts.resolved + ' resolved' : 'No alerts. Use "Inject demo fault" or a pole’s details to simulate one.');
    document.querySelectorAll('[data-alert-count]').forEach(function (c) { c.hidden = !open; setText(c, open); setAttr(c, 'aria-label', open + ' open alerts'); });

    var ak = state.alerts.map(function (a) { return a.id + a.status; }).join();
    if (ak !== alertKey) {
      alertKey = ak;
      $('alertList').innerHTML = state.alerts.length ? state.alerts.map(function (a) {
        var f = M.FAULT_TYPES[a.type];
        var statusTag = a.status === 'active' ? '<span class="tag warn">Active</span>' : a.status === 'acknowledged' ? '<span class="tag amber">Acknowledged</span>' : '<span class="tag ok">Resolved</span>';
        return '<li class="alert-item ' + a.status + '">' +
          '<div class="ai-top"><b>' + esc(f.label) + ' · ' + a.lightId + '</b><span style="display:flex;gap:6px">' +
            '<span class="tag ' + (a.severity === 'high' ? 'warn' : 'amber') + '">Severity ' + a.severity + '</span>' + statusTag + '</span></div>' +
          '<div class="ai-meta">' + esc(zoneName(a.zoneId)) + ' · detected ' + stamp(a.detectedAt) +
            (a.ackAt !== null && a.status !== 'active' ? ' · acknowledged ' + M.fmtTime(a.ackAt) : '') +
            (a.resolvedAt !== null ? ' · resolved ' + M.fmtTime(a.resolvedAt) : '') + ' · ' + a.id + '</div>' +
          (a.status !== 'resolved' ? '<div class="ai-desc">' + esc(f.description) + '</div>' : '') +
          '<div class="ai-btns">' +
            (a.status === 'active' ? '<button class="btn btn-sm" type="button" data-act="ack" data-alert="' + a.id + '">Acknowledge</button>' : '') +
            (a.status !== 'resolved' ? '<button class="btn btn-sm btn-primary" type="button" data-act="resolve" data-alert="' + a.id + '">Mark resolved</button>' : '') +
            '<button class="btn btn-sm" type="button" data-act="details" data-id="' + a.lightId + '">Locate pole</button>' +
          '</div></li>';
      }).join('') : '<li class="empty">No faults reported in this session.</li>';
    }

    var lk = (state.log[0] ? state.log[0].id : 0) + ui.logFilter + state.log.length;
    if (lk !== logKey) {
      logKey = lk;
      var items = state.log.filter(function (e) { return ui.logFilter === 'all' || e.type === ui.logFilter; }).slice(0, 150);
      $('logList').innerHTML = items.length ? items.map(function (e) {
        return '<li class="log-item"><time title="' + stamp(e.minute) + '">' + M.fmtTime(e.minute) + '</time>' +
          '<span><span class="lt ' + e.type + '">' + esc(M.LOG_TYPES[e.type]) + '</span>' + esc(e.message) + '</span></li>';
      }).join('') : '<li class="empty">No events of this type yet.</li>';
    }
  }

  function renderHud(state, sum) {
    var m = M.minuteOfDay(state.minute);
    setText($('simClock'), M.fmtTime(state.minute));
    setText($('phase'), scene.phaseOf(m / 60));
    setText($('simSub'), ffRemaining > 0 ? 'Fast-forwarding… ' + M.fmtDuration(ffRemaining) + ' left'
      : 'Day ' + M.dayNumber(state.minute) + ' · simulated clock (1 s = 1 min)' + (state.running ? '' : ' · paused'));
    setText($('btnPause'), state.running ? 'Pause' : 'Resume');
    setAttr($('btnPause'), 'aria-pressed', state.running ? 'false' : 'true');
    var s = state.schedule, toOn = M.minutesUntil(state.minute, s.onTime), toOff = M.minutesUntil(state.minute, s.offTime);
    var target = toOn <= toOff ? s.onTime : s.offTime;
    setText($('btnNext'), 'Skip to ' + (target === s.onTime ? 'dusk ' : 'dawn ') + M.fmtTime(target));
    $('btnNext')._target = target;
    $('btnPlus3').disabled = $('btnNext').disabled = ffRemaining > 0;
    setText($('hdrStatus'), (ffRemaining > 0 ? 'Simulation fast-forwarding' : state.running ? 'Simulation running' : 'Simulation paused') +
      ' · ' + sum.on + ' of ' + sum.total + ' lit');
    $('simDot').classList.toggle('paused', !state.running && ffRemaining === 0);
  }

  function renderFilters() {
    document.querySelectorAll('[data-zone-filter] [data-zone]').forEach(function (b) {
      setAttr(b, 'aria-pressed', b.getAttribute('data-zone') === ui.zone ? 'true' : 'false');
    });
    document.querySelectorAll('#statusFilter [data-status]').forEach(function (b) {
      setAttr(b, 'aria-pressed', b.getAttribute('data-status') === ui.status ? 'true' : 'false');
    });
    document.querySelectorAll('#periodSeg [data-period]').forEach(function (b) {
      setAttr(b, 'aria-pressed', b.getAttribute('data-period') === ui.period ? 'true' : 'false');
    });
    document.querySelectorAll('#logFilter [data-log]').forEach(function (b) {
      setAttr(b, 'aria-pressed', b.getAttribute('data-log') === ui.logFilter ? 'true' : 'false');
    });
  }

  var lastToastLog = 0;
  function eventToasts(state) {
    var fresh = state.log.filter(function (e) { return e.id > lastToastLog; });
    if (!fresh.length) return;
    lastToastLog = state.log[0].id;
    var shown = 0;
    fresh.reverse().forEach(function (e) {
      if (shown >= 2) return;
      if (e.type === 'fault' && /detected/.test(e.message)) { toast(e.message, 'warn'); shown++; }
      else if (e.type === 'automation' && /^Schedule \(/.test(e.message)) { toast(e.message.replace(/ · .*$/, '')); shown++; }
    });
  }

  var forceCharts = false;
  function render() {
    var state = sim.getState(), sum = sim.summary();
    renderHud(state, sum);
    scene.update(state, ui);
    renderFilters();
    renderPanel(state);
    renderAutomation(state, sum);
    renderOverview(state, sum);
    renderCards(state);
    renderAnalytics(state, sum, forceCharts);
    forceCharts = false;
    renderActivity(state);
    renderDemo();
    eventToasts(state);
  }

  /* ================================================================== *
   * Simulated clock: one timer, drift-corrected
   * ================================================================== */
  var timer = 0, nextAt = 0, ffRemaining = 0, ffChunk = 1;
  var FF_STEP_MS = 30;
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(loop, Math.max(0, delay));
  }
  function loop() {
    timer = 0;
    if (ffRemaining > 0) {
      var n = Math.min(ffRemaining, ffChunk);
      ffRemaining -= n;
      sim.tick(n);
      if (ffRemaining > 0) { schedule(FF_STEP_MS); return; }
      forceCharts = true; requestRender();
      nextAt = performance.now();
    } else {
      if (!sim.getState().running) return;
      sim.tick(1);
    }
    if (!sim.getState().running) return;
    nextAt += 1000;
    var now = performance.now();
    if (nextAt < now - 1000) nextAt = now + 1000;  // tab was in the background: don't burst
    schedule(nextAt - now);
  }
  function startClock() { nextAt = performance.now() + 1000; schedule(1000); }
  function fastForward(mins) {
    if (ffRemaining > 0 || mins <= 0) return;
    ffRemaining = mins;
    ffChunk = Math.max(1, Math.ceil(mins / 70));     // finishes in about 2 seconds
    requestRender();
    schedule(0);
  }

  /* ================================================================== *
   * Interaction
   * ================================================================== */
  function selectPole(id, opts) {
    opts = opts || {};
    ui.selectedId = id;
    render();
    if (id) {
      var sc = $('sceneScroll');
      if (sc.scrollWidth > sc.clientWidth) {
        var x = scene.lampX(id) / 1200 * sc.scrollWidth;
        sc.scrollTo({ left: Math.max(0, x - sc.clientWidth / 2), behavior: reduceMotion ? 'auto' : 'smooth' });
      }
      if (opts.scroll) $('street').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      if (opts.focus) { var c = $('polePanel').querySelector('[data-act=close]'); if (c) c.focus({ preventScroll: true }); }
    }
  }

  function setZone(z) {
    ui.zone = z;
    requestRender();
    if (z !== 'all') {
      var sc = $('sceneScroll');
      if (sc.scrollWidth > sc.clientWidth) {
        var idx = ZONES.findIndex(function (x) { return x.id === z; });
        sc.scrollTo({ left: (idx * 400 + 200) / 1200 * sc.scrollWidth - sc.clientWidth / 2, behavior: reduceMotion ? 'auto' : 'smooth' });
      }
    }
  }

  // Controls shared by light cards and the pole panel
  function bindLightControls(root) {
    root.addEventListener('change', function (e) {
      var t = e.target, id = t.getAttribute('data-id'), r = t.getAttribute('data-r');
      if (r === 'toggle') {
        report(sim.setLightPower(id, t.checked));
        requestRender();
      } else if (r === 'range') {
        var from = t._from !== undefined ? t._from : sim.light(id).brightness;
        t._dragging = false; t._from = undefined;
        report(sim.setBrightness(id, t.value, { from: from }));
      }
    });
    root.addEventListener('input', function (e) {
      var t = e.target;
      if (t.getAttribute('data-r') !== 'range') return;
      var id = t.getAttribute('data-id');
      if (t._from === undefined) t._from = sim.light(id).brightness;
      t._dragging = true;
      sim.setBrightness(id, t.value, { log: false });
    });
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act'), id = b.getAttribute('data-id'), zone = b.getAttribute('data-zone');
      if (act === 'details') selectPole(id, { scroll: true, focus: true });
      else if (act === 'auto') report(sim.setAuto(id));
      else if (act === 'close') { var prev = ui.selectedId; selectPole(null); var g = document.querySelector('#sceneSvg .lamp[data-id="' + prev + '"]'); if (g) g.focus({ preventScroll: true }); }
      else if (act === 'fault') report(sim.injectFault(id, $('pp-ftype').value));
      else if (act === 'ack') report(sim.acknowledgeAlert(b.getAttribute('data-alert')));
      else if (act === 'resolve') report(sim.resolveAlert(b.getAttribute('data-alert')));
      else if (act === 'zone-on') report(sim.setZonePower(zone, true));
      else if (act === 'zone-off') {
        confirmAction('Switch off ' + zoneName(zone) + '?', 'All 4 lights in ' + zoneName(zone) + ' will be switched off and put on manual override, so the schedule will not switch them back on until you resume automation.', 'Switch zone off')
          .then(function (ok) { if (ok) report(sim.setZonePower(zone, false)); });
      }
    });
  }

  function bindRadioKeys(group, selector) {
    group.addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      var t = e.target.closest(selector);
      if (!t) return;
      var items = Array.prototype.slice.call(t.parentNode.querySelectorAll(selector));
      var i = items.indexOf(t) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
      var nxt = items[(i + items.length) % items.length];
      e.preventDefault();
      nxt.click(); nxt.focus();
    });
  }

  function bindEvents() {
    bindLightControls($('zones'));
    bindLightControls($('polePanel'));
    bindLightControls($('alertList'));
    bindLightControls($('faultBanner'));

    var svg = $('sceneSvg');
    svg.addEventListener('click', function (e) {
      var g = e.target.closest('.lamp');
      if (g) selectPole(ui.selectedId === g.getAttribute('data-id') ? null : g.getAttribute('data-id'));
    });
    svg.addEventListener('keydown', function (e) {
      var g = e.target.closest('.lamp');
      if (!g) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPole(g.getAttribute('data-id'), { focus: true }); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ui.selectedId && !$('confirmDlg').open) {
        var prev = ui.selectedId; selectPole(null);
        var g = document.querySelector('#sceneSvg .lamp[data-id="' + prev + '"]'); if (g) g.focus({ preventScroll: true });
      }
    });

    document.querySelectorAll('[data-zone-filter]').forEach(function (g) {
      g.addEventListener('click', function (e) { var b = e.target.closest('[data-zone]'); if (b) setZone(b.getAttribute('data-zone')); });
    });
    $('zoneSums').addEventListener('click', function (e) {
      var b = e.target.closest('[data-zone-sum]');
      if (!b) return;
      var z = b.getAttribute('data-zone-sum');
      setZone(ui.zone === z ? 'all' : z);
    });
    $('statusFilter').addEventListener('click', function (e) {
      var b = e.target.closest('[data-status]'); if (b) { ui.status = b.getAttribute('data-status'); requestRender(); }
    });
    $('periodSeg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-period]'); if (b) { ui.period = b.getAttribute('data-period'); forceCharts = true; requestRender(); }
    });
    $('logFilter').addEventListener('click', function (e) {
      var b = e.target.closest('[data-log]'); if (b) { ui.logFilter = b.getAttribute('data-log'); requestRender(); }
    });

    // Quick actions
    $('btnAllOn').addEventListener('click', function () {
      var r = report(sim.setAllPower(true));
      if (r.ok) toast('All lights on (' + r.changed + ' changed' + (r.skipped.length ? ', ' + r.skipped.length + ' faulted skipped' : '') + '). Manual override until you resume automation.', 'ok');
    });
    $('btnAllOff').addEventListener('click', function () {
      confirmAction('Switch all lights off?', 'All 12 streetlights go dark and stay off (manual override) even after dusk, until you resume automation. This can leave roads unlit.', 'Switch all off')
        .then(function (ok) { if (ok) { var r = report(sim.setAllPower(false)); if (r.ok) toast('All lights off (' + r.changed + ' changed)', 'ok'); } });
    });
    $('btnEco').addEventListener('click', function () { report(sim.setPolicy(sim.getState().policy === 'eco' ? 'full' : 'eco')); });

    // Schedule
    $('schedToggle').addEventListener('change', function (e) { report(sim.setSchedule({ enabled: e.target.checked })); });
    ['schedOn', 'schedOff'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        var r = sim.setSchedule(id === 'schedOn' ? { onTime: $(id).value } : { offTime: $(id).value });
        setText($('schedErr'), r.ok ? '' : r.reason);
        $(id).setAttribute('aria-invalid', r.ok ? 'false' : 'true');
        if (!r.ok) { $(id).value = M.fmtTime(sim.getState().schedule[id === 'schedOn' ? 'onTime' : 'offTime']); }
      });
    });
    $('btnResume').addEventListener('click', function () { var r = report(sim.resumeAutomation()); if (r.ok) toast('Automation resumed for ' + plural(r.cleared, 'light'), 'ok'); });

    // Policy
    $('policySeg').addEventListener('click', function (e) { var b = e.target.closest('[data-policy]'); if (b) report(sim.setPolicy(b.getAttribute('data-policy'))); });
    bindRadioKeys($('policySeg'), '[data-policy]');
    $('activityRows').addEventListener('click', function (e) {
      var b = e.target.closest('[data-activity]'); if (b) report(sim.setActivity(b.getAttribute('data-zone'), b.getAttribute('data-activity')));
    });
    bindRadioKeys($('activityRows'), '[data-activity]');
    document.querySelectorAll('[data-level]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var r = sim.setAdaptiveLevel(inp.getAttribute('data-level'), inp.value);
        setText($('levelErr'), r.ok ? '' : r.reason);
        inp.setAttribute('aria-invalid', r.ok ? 'false' : 'true');
        if (!r.ok) inp.value = sim.getState().adaptiveLevels[inp.getAttribute('data-level')];
      });
    });
    $('ecoLevel').addEventListener('change', function () {
      var r = sim.setEcoLevel($('ecoLevel').value);
      setText($('ecoErr'), r.ok ? '' : r.reason);
      $('ecoLevel').setAttribute('aria-invalid', r.ok ? 'false' : 'true');
      if (!r.ok) $('ecoLevel').value = sim.getState().ecoLevel;
    });

    // Analytics
    $('tariff').addEventListener('change', function () {
      var r = sim.setTariff($('tariff').value);
      setText($('tariffErr'), r.ok ? '' : r.reason);
      $('tariff').setAttribute('aria-invalid', r.ok ? 'false' : 'true');
      if (!r.ok) $('tariff').value = sim.getState().tariff;
    });

    // Activity
    $('btnDemoFault').addEventListener('click', function () { report(sim.injectDemoFault()); });

    // Clock
    $('btnPause').addEventListener('click', function () {
      var run = !sim.getState().running;
      sim.setRunning(run);
      if (ffRemaining > 0) return;              // the fast-forward loop keeps the single timer
      if (run) startClock(); else clearTimeout(timer);
    });
    $('btnPlus3').addEventListener('click', function () { fastForward(180); });
    $('btnNext').addEventListener('click', function () { fastForward(sim.minutesUntil($('btnNext')._target)); });

    // Theme
    $('themeBtn').addEventListener('click', function () {
      var dark = !isDark();
      if (dark) document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('lumen-theme', dark ? 'dark' : 'light'); } catch (err) { /* storage unavailable */ }
      syncThemeChrome();
      forceCharts = true; requestRender();
    });

    // Demo panel
    $('demoBtn').addEventListener('click', function () { toggleDemo(); });
    $('demoClose').addEventListener('click', function () { toggleDemo(false); });
    $('demoSteps').addEventListener('click', function (e) {
      var b = e.target.closest('[data-step]'); if (b) runStep(+b.getAttribute('data-step'));
    });
    $('btnReset').addEventListener('click', function () { askReset(); });
  }

  function syncThemeChrome() {
    var dark = isDark();
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', dark ? '#23262e' : '#e4e6eb');
    $('themeBtn').setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }

  /* ---------- reset ---------- */
  function askReset() {
    return confirmAction('Reset the demo?', 'This restores 17:50 on Day 1: all lights automatic at 100%, default schedule and tariff, no faults, and it clears the activity log and analytics. Your theme is kept.', 'Reset demo')
      .then(function (ok) {
        if (!ok) return false;
        ffRemaining = 0;
        sim.reset();
        ui.zone = 'all'; ui.status = 'all'; ui.selectedId = null; ui.period = 'live'; ui.logFilter = 'all'; ui.demoDone = {};
        lastToastLog = sim.getState().log[0].id;
        forceCharts = true;
        render();
        startClock();
        toast('Demo reset to 17:50, Day 1', 'ok');
        return true;
      });
  }

  /* ---------- demo guide ---------- */
  function go(id) { $(id).scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); }
  var STEPS = [
    { label: 'Reset to the start state (17:50, all automatic)', run: function () { return askReset(); } },
    { label: 'Skip to dusk: the schedule switches lights on', run: function () { go('street'); fastForward(sim.minutesUntil(sim.getState().schedule.onTime)); } },
    { label: 'Inspect pole MR-02 in the street', run: function () { selectPole('MR-02', { scroll: true }); } },
    { label: 'Dim MR-02 to 40% (manual override)', run: function () { var f = sim.light('MR-02').brightness; report(sim.setBrightness('MR-02', 40, { from: f })); selectPole('MR-02'); } },
    { label: 'Switch Campus Lane off (zone action)', run: function () { report(sim.setZonePower('campus', false)); go('overview'); } },
    { label: 'Enable Adaptive Lighting; Market Street activity → low', run: function () { report(sim.setPolicy('adaptive')); report(sim.setActivity('market', 'low')); go('street'); } },
    { label: 'Inject a demo fault (lamp failure on MS-02)', run: function () { report(sim.injectDemoFault()); go('overview'); } },
    { label: 'Acknowledge the alert', run: function () { var a = firstAlert('active'); if (a) report(sim.acknowledgeAlert(a.id)); else toast('No active alert. Run the previous step first.', 'warn'); go('activity'); } },
    { label: 'Resolve the alert', run: function () { var a = firstAlert('acknowledged') || firstAlert('active'); if (a) report(sim.resolveAlert(a.id)); else toast('No open alert to resolve.', 'warn'); go('activity'); } },
    { label: 'Review today’s energy, cost and savings', run: function () { ui.period = 'today'; forceCharts = true; requestRender(); go('analytics'); } }
  ];
  function firstAlert(status) { return sim.getState().alerts.filter(function (a) { return a.status === status; })[0]; }
  function buildDemo() {
    $('demoSteps').innerHTML = STEPS.map(function (s, i) {
      return '<li data-li="' + i + '"><span>' + esc(s.label) + '</span><button class="btn btn-sm" type="button" data-step="' + i + '">Run</button></li>';
    }).join('');
  }
  function runStep(i) {
    var res = STEPS[i].run();
    var mark = function (ok) { if (ok !== false) { ui.demoDone[i] = true; requestRender(); } };
    if (res && typeof res.then === 'function') res.then(mark); else mark(true);
  }
  function renderDemo() {
    document.querySelectorAll('#demoSteps [data-li]').forEach(function (li) { li.classList.toggle('done', !!ui.demoDone[li.getAttribute('data-li')]); });
  }
  function toggleDemo(force) {
    var p = $('demoPanel'), open = force === undefined ? p.hidden : force;
    p.hidden = !open;
    $('demoBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) $('demoSteps').querySelector('button').focus(); else $('demoBtn').focus();
  }

  /* ---------- section nav (scroll-spy) ---------- */
  function setupNav() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.navpill a'));
    var hdr = document.querySelector('header'), ticking = false;
    function update() {
      ticking = false;
      var cur = SECTIONS[0].id;
      SECTIONS.forEach(function (s) { var el = $(s.id); if (el && el.getBoundingClientRect().top <= 160) cur = s.id; });
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 6) cur = SECTIONS[SECTIONS.length - 1].id;
      links.forEach(function (a) {
        var on = a.getAttribute('data-nav') === cur;
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
        var box = a.parentNode;
        if (on && box.offsetParent && box.scrollWidth > box.clientWidth) box.scrollTo({ left: a.offsetLeft - (box.clientWidth - a.offsetWidth) / 2, behavior: 'smooth' });
      });
      hdr.classList.toggle('scrolled', window.scrollY > 8);
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  /* ================================================================== *
   * Init
   * ================================================================== */
  buildNav();
  buildZoneFilters();
  buildZoneSummaries();
  buildActivityRows();
  buildLightCards();
  buildDemo();
  buildGauge(sim.summary().maxW);
  var scene = window.LumenScene.create($('sceneSvg'), $('scene'), ZONES, sim.getState().lights);
  var charts = window.LumenCharts.create($('timeChart'), $('zoneChart'), ZONES);
  bindEvents();
  syncThemeChrome();
  lastToastLog = sim.getState().log[0].id;
  sim.subscribe(requestRender);
  forceCharts = true;
  render();
  setupNav();
  startClock();

  // Exposed for debugging and automated browser tests only.
  window.LumenGrid = { sim: sim, ui: ui, fastForward: fastForward };
})();
