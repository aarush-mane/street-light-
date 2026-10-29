# 💡 LumenGrid – Smart Streetlight Control

A dashboard for monitoring, controlling and optimising **12 simulated streetlights** across three road zones: Main Road, Market Street and Campus Lane.

**Live demo:** https://vedantfr45.github.io/Webathon/

> Built for the Live Development Webathon (Innovation Day, PRPCET IIC Cell), where it placed 2nd, then upgraded afterwards.
>
> ⚠️ **Everything is a frontend simulation.** No physical lights, traffic sensors, meters, servers or AI models are connected. Values are labelled as simulated, calculated, or generated demo history.

---

## ✨ Features

| Area | What you can do |
|---|---|
| **Street** | Live SVG street with a sky that follows the simulated clock. Click or keyboard-select a pole to open its details panel: state, brightness, power, control mode, health and last change. You can switch it on or off, dim it, return it to automatic or simulate a fault. Highlight a zone without changing any light. |
| **Schedule** | Dusk-to-dawn schedule (default ON 18:00 / OFF 06:00) with editable times, including windows that cross midnight. Shows the next action and countdown. Pause, **+3 h** and **Skip to dusk/dawn** controls. |
| **Brightness policy** | **Full** (100%), **Eco** (configurable, default 50%) or **Adaptive Lighting**: per-zone brightness follows a *simulated* activity level (low / moderate / high → editable targets, default 30 / 60 / 100%). |
| **Manual vs automatic** | Any operator command puts a light on **manual override**, which automation never touches. **Resume automation** hands every light back. |
| **Overview** | Total lights, on/off, active faults, live power, a power gauge, today's energy, cost, baseline and savings, plus selectable zone summaries. |
| **Lights** | 12 cards with on/off, brightness, power, status (icon + text) and mode. Filter by zone and status. Zone on/off and all on/off controls. **All off** and **zone off** ask for confirmation. |
| **Analytics** | Live / Today / 7 days / 30 days. Energy, cost, baseline and savings, actual-vs-baseline chart, energy by zone, editable tariff (₹/kWh). |
| **Faults & alerts** | Lamp failure, driver/electrical fault and communication loss. Alerts can be acknowledged and then resolved. Faults show on the pole, card, zone, overview banner and nav badge. A deterministic **Inject demo fault** button. |
| **Activity log** | Every meaningful change with simulated time, filterable by lighting / automation / energy / faults. Slider drags are grouped into one entry. |
| **Demo guide** | A 10-step, repeatable demo script plus **Reset demo**. |
| **Design** | Neumorphic light theme and dark theme (saved). Responsive from 360 px to desktop, with keyboard focus states, labelled controls and `prefers-reduced-motion` support. |

---

## 🧮 Energy model

| Quantity | Formula |
|---|---|
| Power of one light | `rated W (100) × brightness % ÷ 100`, or **0 W** when off |
| Faults | Lamp/driver fault → no output, 0 W. Communication loss → keeps its last state *and* its power draw, but cannot take commands |
| Energy | Power is sampled once per simulated minute: `kWh += W ÷ 1000 ÷ 60` |
| Cost | `kWh × tariff` (default ₹8/kWh, editable) |
| Baseline | A conventional dusk-to-dawn system: all 12 lights at 100% during the configured on-window, no dimming |
| Savings | `baseline − actual` over the same period. It can be negative if lights run outside the schedule |

The clock runs at 1 real second = 1 simulated minute and starts at **17:50 on Day 1**. The 7- and 30-day views combine days this simulation actually ran with **deterministic generated history**, shown as hatched bars and labelled as not measured.

---

## 🛠️ Tech and structure

Plain **HTML + CSS + JavaScript**. No framework, no build step, no runtime dependencies besides Chart.js from a CDN.

```
index.html        page structure
css/styles.css    neumorphic light/dark theme, responsive layout
js/model.js       simulation model – the single source of truth (no DOM; also runs in Node)
js/scene.js       SVG street scene
js/charts.js      Chart.js charts
js/app.js         UI: renders model state, sends user actions to the model
tests/            unit tests for the model (node:test)
```

All totals (on/off, power, zone figures, energy, cost, savings) are **derived** from the light list in `js/model.js`. Nothing is hard-coded per section.

---

## ▶️ Run

Open `index.html` in a browser. It works directly from the file system or from GitHub Pages. The charts need an internet connection for Chart.js; without it, everything else still works.

## ✅ Test

```bash
npm test        # 17 unit tests for the simulation model (Node 18+)
npm run check   # syntax check of all scripts
```

---

## 🎬 Demo in 2 minutes

Open **Demo guide** (top right) and press **Run** on each step:

1. Reset → 17:50, all automatic
2. Skip to dusk → the schedule switches 12 lights on
3. Inspect pole MR-02
4. Dim MR-02 to 40% → manual override
5. Switch Campus Lane off
6. Enable Adaptive Lighting, set Market Street activity to low → 30%
7. Inject a demo fault (lamp failure on MS-02)
8. Acknowledge the alert
9. Resolve the alert
10. Review today's energy, cost and savings

---

## Known limitations

- Simulation only. Activity levels are typed in by the operator, not read from sensors.
- The activity log, alerts and analytics live in the browser tab and reset on reload (only the theme is saved).
- Energy is sampled once per simulated minute, so changes made mid-minute count from the next minute.

Built by **Vedant**
