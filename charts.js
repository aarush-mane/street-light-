/*
 * LumenGrid charts (Chart.js 4). Both charts are drawn from the analytics
 * object produced by LumenModel.analytics(), so they always agree with the
 * metric cards.
 */
(function (root) {
  'use strict';

  var AMBER = '#f2a516';

  function create(timeCanvas, zoneCanvas, zones) {
    if (typeof root.Chart === 'undefined') {
      [timeCanvas, zoneCanvas].forEach(function (c) {
        var p = document.createElement('p');
        p.className = 'muted';
        p.style.cssText = 'font-size:.85rem;padding:16px';
        p.textContent = 'Charts need an internet connection to load Chart.js. All numbers above still work.';
        c.parentNode.replaceChild(p, c);
      });
      return { available: false, update: function () {} };
    }
    var Chart = root.Chart;
    Chart.defaults.font.family = "'Poppins', system-ui, sans-serif";
    Chart.defaults.font.size = 11;

    var theme = { tick: '#5b6272', grid: 'rgba(47,52,63,.08)', base: '#7a8191', baseFill: 'rgba(91,98,114,.22)', tipBg: '#2f343f' };
    var timeChart = null, zoneChart = null, currentKind = null;

    function fmt(v, unit) {
      if (v === null || v === undefined) return '–';
      return unit === 'W' ? Math.round(v).toLocaleString('en-IN') + ' W' : v.toFixed(3) + ' kWh';
    }

    function tooltip(extra) {
      return {
        backgroundColor: function () { return theme.tipBg; }, titleColor: '#fff', bodyColor: '#fff',
        padding: 10, cornerRadius: 10, displayColors: false, callbacks: extra
      };
    }

    function scaleTitle(text) { return { display: true, text: text, color: function () { return theme.tick; }, font: { size: 11, weight: '500' } }; }

    function buildTime(a) {
      if (timeChart) timeChart.destroy();
      var live = a.period === 'live';
      currentKind = a.period;
      timeChart = new Chart(timeCanvas, {
        type: live ? 'line' : 'bar',
        data: {
          labels: [],
          datasets: [
            {
              label: 'Actual', data: [], order: 2,
              borderColor: AMBER, borderWidth: live ? 3 : 0, pointRadius: 0, pointHoverRadius: 5,
              pointHoverBackgroundColor: AMBER, tension: 0.3, fill: live,
              borderRadius: 6, maxBarThickness: 28,
              backgroundColor: live ? function (ctx) {
                var c = ctx.chart, ar = c.chartArea;
                if (!ar) return 'rgba(242,165,22,.15)';
                var g = c.ctx.createLinearGradient(0, ar.top, 0, ar.bottom);
                g.addColorStop(0, 'rgba(242,165,22,.28)'); g.addColorStop(1, 'rgba(242,165,22,0)');
                return g;
              } : []
            },
            live ? {
              type: 'line', label: 'Baseline', data: [], order: 1,
              borderColor: function () { return theme.base; }, borderWidth: 2, borderDash: [6, 5],
              pointRadius: 0, pointHoverRadius: 4, fill: false, tension: 0
            } : {
              type: 'bar', label: 'Baseline', data: [], order: 3,
              backgroundColor: function () { return theme.baseFill; }, borderRadius: 6, maxBarThickness: 28
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          animation: { duration: 450, easing: 'easeOutCubic' },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: tooltip({
              label: function (c) {
                var gen = c.datasetIndex === 0 && timeChart._generated && timeChart._generated[c.dataIndex];
                return c.dataset.label + ': ' + fmt(c.parsed.y, timeChart._unit) + (gen ? ' (generated)' : '');
              }
            })
          },
          scales: {
            x: {
              grid: { display: false }, border: { display: false },
              ticks: { maxTicksLimit: live ? 7 : 12, maxRotation: 0, autoSkip: true, color: function () { return theme.tick; } },
              title: scaleTitle(live ? 'Simulated time' : a.period === 'today' ? 'Hour of day (simulated)' : 'Day')
            },
            y: {
              grid: { color: function () { return theme.grid; } }, border: { display: false }, beginAtZero: true,
              suggestedMax: live ? 1200 : undefined,
              ticks: { maxTicksLimit: 6, color: function () { return theme.tick; }, callback: function (v) { return live ? v + ' W' : v + ' kWh'; } },
              title: scaleTitle(live ? 'Power (W)' : 'Energy (kWh)')
            }
          }
        }
      });
    }

    zoneChart = new Chart(zoneCanvas, {
      type: 'bar',
      data: {
        labels: zones.map(function (z) { return z.name; }),
        datasets: [{ label: 'Energy', data: zones.map(function () { return 0; }), backgroundColor: zones.map(function (z) { return z.color; }), borderRadius: 10, borderSkipped: false, maxBarThickness: 44 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 450, easing: 'easeOutCubic' },
        plugins: {
          legend: { display: false },
          tooltip: tooltip({ label: function (c) { return c.parsed.y.toFixed(3) + ' kWh · ₹' + (c.parsed.y * zoneChart._tariff).toFixed(2); } })
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: function () { return theme.tick; } } },
          y: {
            grid: { color: function () { return theme.grid; } }, border: { display: false }, beginAtZero: true,
            ticks: { maxTicksLimit: 6, color: function () { return theme.tick; } },
            title: scaleTitle('Energy (kWh)')
          }
        }
      }
    });

    function update(a, opts) {
      opts = opts || {};
      if (opts.dark !== undefined) {
        theme = opts.dark
          ? { tick: '#a9afbd', grid: 'rgba(255,255,255,.08)', base: '#8a90a0', baseFill: 'rgba(169,175,189,.2)', tipBg: '#0f1116' }
          : { tick: '#5b6272', grid: 'rgba(47,52,63,.08)', base: '#7a8191', baseFill: 'rgba(91,98,114,.22)', tipBg: '#2f343f' };
      }
      if (currentKind !== a.period) buildTime(a);
      var ds = timeChart.data.datasets;
      timeChart._unit = a.unit;
      timeChart._generated = a.generated;
      timeChart.data.labels = a.labels.slice();
      ds[0].data = a.actual.slice();
      ds[1].data = a.baseline.slice();
      if (a.period !== 'live') {
        ds[0].backgroundColor = a.generated.map(function (g) { return g ? 'rgba(242,165,22,.35)' : AMBER; });
        ds[0].borderColor = a.generated.map(function (g) { return g ? 'rgba(242,165,22,.9)' : AMBER; });
        ds[0].borderWidth = a.generated.map(function (g) { return g ? 1.5 : 0; });
      }
      timeChart.update(opts.instant ? 'none' : undefined);

      zoneChart._tariff = a.tariff;
      zoneChart.data.datasets[0].data = zones.map(function (z) { return +a.zoneKWh[z.id].toFixed(4); });
      zoneChart.update(opts.instant ? 'none' : undefined);
    }

    return { available: true, update: update };
  }

  root.LumenCharts = { create: create };
})(typeof self !== 'undefined' ? self : this);
