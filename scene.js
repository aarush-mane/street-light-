/*
 * LumenGrid street scene: an SVG skyline whose sky follows the simulated
 * clock, with one lamp post per light. Lamps render the shared model state
 * (on / dimmed / off / fault / manual / selected). Clicking a lamp only
 * selects it; changes go through the model.
 */
(function (root) {
  'use strict';
  var M = root.LumenModel;

  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rgb(c) { return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'; }
  function hex(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }

  // [hour, sky top, sky bottom]
  var SKY = [
    [0, '#0b1026', '#1b2447'], [5, '#141a3a', '#3b3f73'], [6, '#3c4a8a', '#f4a26b'], [7.5, '#6fb1ea', '#cfe8f7'],
    [12, '#4a9be8', '#bfe3fa'], [16.5, '#5aa4e6', '#e9e1c8'], [18, '#5b4a8c', '#f08a4b'], [19, '#2a2a5c', '#8a4a6a'],
    [20, '#12163a', '#2a2f5e'], [24, '#0b1026', '#1b2447']
  ].map(function (k) { return [k[0], hex(k[1]), hex(k[2])]; });

  function skyAt(h) {
    for (var i = 0; i < SKY.length - 1; i++) {
      if (h >= SKY[i][0] && h <= SKY[i + 1][0]) {
        var t = (h - SKY[i][0]) / (SKY[i + 1][0] - SKY[i][0]);
        return [mix(SKY[i][1], SKY[i + 1][1], t), mix(SKY[i][2], SKY[i + 1][2], t)];
      }
    }
    return [SKY[0][1], SKY[0][2]];
  }
  function nightFactor(h) {
    if (h >= 20 || h < 5) return 1;
    if (h < 6.5) return 1 - (h - 5) / 1.5;
    if (h < 17.5) return 0;
    return (h - 17.5) / 2.5;
  }
  function phaseOf(h) {
    if (h >= 5 && h < 7) return 'Dawn';
    if (h >= 7 && h < 17) return 'Daytime';
    if (h >= 17 && h < 19.5) return 'Dusk';
    return 'Night';
  }

  function lampMarkup(l, n) {
    var x = 50 + 100 * n;
    return '<g class="lamp" data-id="' + l.id + '" data-zone="' + l.zoneId + '" transform="translate(' + x + ',0)" tabindex="0" role="button" aria-pressed="false">' +
      '<rect class="hit" x="-34" y="80" width="100" height="196"/>' +
      '<rect class="sel" x="-30" y="84" width="92" height="190" rx="12"/>' +
      '<polygon class="cone" points="17,123 31,123 100,251 -52,251"/>' +
      '<ellipse class="pool" cx="24" cy="252" rx="74" ry="9"/>' +
      '<path class="pole" d="M0 250 V132 Q0 114 20 114 H24"/>' +
      '<rect class="base" x="-7" y="245" width="14" height="6" rx="2"/>' +
      '<circle class="halo" cx="24" cy="123" r="40"/>' +
      '<rect class="head" x="11" y="114" width="28" height="9" rx="4.5"/>' +
      '<circle class="mode-dot" cx="12" cy="244" r="4"/>' +
      '<g class="warn" transform="translate(25,92)"><polygon points="0,-11 11,8 -11,8"/><text y="6">!</text></g>' +
      '<text class="lamp-id" x="0" y="269">' + l.id + '</text>' +
      '</g>';
  }

  function create(svg, sceneEl, zones, lights) {
    var r = rng(11), h = '', i, x, w, hh;
    h += '<defs>' +
      '<linearGradient id="coneGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe19a" stop-opacity=".8"/><stop offset="1" stop-color="#ffe19a" stop-opacity="0"/></linearGradient>' +
      '<radialGradient id="haloGrad"><stop offset="0" stop-color="#fff3c9" stop-opacity=".95"/><stop offset=".35" stop-color="#ffd27a" stop-opacity=".45"/><stop offset="1" stop-color="#ffb627" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="poolGrad"><stop offset="0" stop-color="#ffe19a" stop-opacity=".65"/><stop offset="1" stop-color="#ffe19a" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="sunHalo"><stop offset="0" stop-color="#fff0b0" stop-opacity=".85"/><stop offset=".45" stop-color="#ffd27a" stop-opacity=".25"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="moonHalo"><stop offset="0" stop-color="#cfd8ff" stop-opacity=".5"/><stop offset="1" stop-color="#cfd8ff" stop-opacity="0"/></radialGradient>' +
      '</defs>';

    h += '<g class="stars" aria-hidden="true">';
    for (i = 0; i < 46; i++) {
      h += '<circle class="star" cx="' + (r() * 1200).toFixed(0) + '" cy="' + (r() * 170).toFixed(0) + '" r="' + (0.6 + r() * 1.1).toFixed(1) + '" style="animation-delay:-' + (r() * 4).toFixed(1) + 's"/>';
    }
    h += '</g>';
    h += '<g id="sun" aria-hidden="true"><circle r="62" fill="url(#sunHalo)"/><circle id="sunCore" r="24" fill="#ffd76a"/></g>';
    h += '<g id="moon" aria-hidden="true"><circle r="48" fill="url(#moonHalo)"/><circle r="19" fill="#f2efe0"/><circle cx="-6" cy="-4" r="4" fill="#d9d5c1"/><circle cx="7" cy="6" r="3" fill="#d9d5c1"/><circle cx="4" cy="-9" r="2" fill="#d9d5c1"/></g>';
    h += '<g class="clouds" aria-hidden="true">';
    [[70, -30, 95], [38, 0, 125], [100, -60, 150]].forEach(function (c) {
      h += '<g class="cloud" style="animation-duration:' + c[2] + 's;animation-delay:' + c[1] + 's"><g transform="translate(0,' + c[0] + ')">' +
        '<ellipse cx="0" cy="0" rx="46" ry="14"/><ellipse cx="-26" cy="4" rx="26" ry="11"/><ellipse cx="28" cy="5" rx="30" ry="11"/><ellipse cx="6" cy="-10" rx="26" ry="12"/></g></g>';
    });
    h += '</g>';

    h += '<g class="far" aria-hidden="true">';
    x = -10;
    while (x < 1210) { w = 44 + r() * 50; hh = 80 + r() * 70; h += '<rect x="' + x.toFixed(0) + '" y="' + (238 - hh).toFixed(0) + '" width="' + w.toFixed(0) + '" height="' + hh.toFixed(0) + '"/>'; x += w + 2 + r() * 6; }
    h += '</g>';
    var near = '', wins = '';
    x = -20;
    while (x < 1210) {
      w = 50 + r() * 55; hh = 50 + r() * 60;
      near += '<rect x="' + x.toFixed(0) + '" y="' + (238 - hh).toFixed(0) + '" width="' + w.toFixed(0) + '" height="' + hh.toFixed(0) + '"/>';
      for (var cy = 238 - hh + 10; cy < 224; cy += 16) {
        for (var cx = x + 7; cx < x + w - 10; cx += 12) {
          if (r() < 0.55) wins += '<rect x="' + cx.toFixed(0) + '" y="' + cy.toFixed(0) + '" width="6" height="8" fill-opacity="' + (0.5 + r() * 0.5).toFixed(2) + '"/>';
        }
      }
      x += w + 4 + r() * 10;
    }
    h += '<g class="near" aria-hidden="true">' + near + '</g><g class="windows" aria-hidden="true">' + wins + '</g>';
    h += '<g aria-hidden="true"><rect class="walk" x="0" y="238" width="1200" height="14"/><rect class="road" x="0" y="252" width="1200" height="48"/>';
    h += '<line class="lane" x1="0" y1="282" x2="1200" y2="282"/>';
    h += '<line class="divider" x1="400" y1="252" x2="400" y2="300"/><line class="divider" x1="800" y1="252" x2="800" y2="300"/>';
    zones.forEach(function (z, zi) {
      h += '<text class="zone-label" x="' + (200 + zi * 400) + '" y="296" text-anchor="middle">' + z.name.toUpperCase() + '</text>';
    });
    zones.forEach(function (z, zi) {
      h += '<rect class="zone-shade" data-zone="' + z.id + '" x="' + (zi * 400) + '" y="0" width="400" height="300"/>';
    });
    h += '</g>';
    lights.forEach(function (l, n) { h += lampMarkup(l, n); });
    svg.innerHTML = h;

    var sunEl = svg.querySelector('#sun'), moonEl = svg.querySelector('#moon'), sunCore = svg.querySelector('#sunCore');
    var lampEls = {};
    svg.querySelectorAll('.lamp').forEach(function (g) { lampEls[g.getAttribute('data-id')] = g; });
    var shades = svg.querySelectorAll('.zone-shade');
    var lastMinute = null;

    function updateSky(minute) {
      var m = M.minuteOfDay(minute);
      if (m === lastMinute) return;
      lastMinute = m;
      var hr = m / 60, n = nightFactor(hr), sk = skyAt(hr), s = sceneEl.style;
      s.setProperty('--sky1', rgb(sk[0]));
      s.setProperty('--sky2', rgb(sk[1]));
      s.setProperty('--night', n.toFixed(3));
      var road = mix(sk[1], mix([54, 60, 76], [22, 25, 36], n), 0.88);
      s.setProperty('--far', rgb(mix(sk[1], mix([92, 110, 158], [20, 26, 50], n), 0.5)));
      s.setProperty('--near', rgb(mix(sk[1], mix([58, 70, 108], [12, 15, 32], n), 0.74)));
      s.setProperty('--road', rgb(road));
      s.setProperty('--walk', rgb(mix(road, [120, 126, 150], 0.25)));
      s.setProperty('--pole', rgb(mix([35, 40, 58], [120, 128, 160], n)));
      var ts = (m - 360) / 720, tm = ((m - 1080 + 1440) % 1440) / 720;
      if (ts >= 0 && ts <= 1) {
        sunEl.style.visibility = 'visible';
        sunEl.setAttribute('transform', 'translate(' + (110 + ts * 980).toFixed(1) + ',' + (236 - Math.sin(Math.PI * ts) * 170).toFixed(1) + ')');
        sunCore.setAttribute('fill', rgb(mix([255, 215, 106], [255, 128, 60], Math.pow(Math.abs(2 * ts - 1), 3))));
      } else sunEl.style.visibility = 'hidden';
      if (tm >= 0 && tm <= 1) {
        moonEl.style.visibility = 'visible';
        moonEl.setAttribute('transform', 'translate(' + (110 + tm * 980).toFixed(1) + ',' + (236 - Math.sin(Math.PI * tm) * 170).toFixed(1) + ')');
      } else moonEl.style.visibility = 'hidden';
    }

    function update(state, ui) {
      updateSky(state.minute);
      state.lights.forEach(function (l) {
        var g = lampEls[l.id];
        if (!g) return;
        var st = M.lightStatus(l), lit = M.isLit(l), sel = ui.selectedId === l.id;
        var hidden = ui.zone !== 'all' && ui.zone !== l.zoneId;
        g.style.setProperty('--b', (l.brightness / 100).toFixed(2));
        g.classList.toggle('on', lit);
        g.classList.toggle('fault', !!l.fault);
        g.classList.toggle('manual', l.mode === 'manual');
        g.classList.toggle('selected', sel);
        g.classList.toggle('dimmed-out', hidden);
        g.setAttribute('aria-pressed', sel ? 'true' : 'false');
        var desc = l.id + ', ' + M.zoneById(l.zoneId).name + ' pole ' + l.pole + ': ' +
          (st === 'fault' ? M.FAULT_TYPES[l.fault.type].label : st === 'off' ? 'off' : 'on at ' + l.brightness + '%') +
          ', ' + Math.round(M.lightPowerW(l)) + ' W' + (l.mode === 'manual' ? ', manual override' : '') + '. Open details.';
        if (g._desc !== desc) { g._desc = desc; g.setAttribute('aria-label', desc); }
      });
      shades.forEach(function (s) {
        s.classList.toggle('on', ui.zone !== 'all' && s.getAttribute('data-zone') !== ui.zone);
      });
    }

    function lampX(id) {
      var g = lampEls[id];
      if (!g) return 0;
      var idx = lights.findIndex(function (l) { return l.id === id; });
      return 50 + 100 * idx;
    }

    return { update: update, lampX: lampX, phaseOf: phaseOf };
  }

  root.LumenScene = { create: create, phaseOf: phaseOf };
})(typeof self !== 'undefined' ? self : this);
