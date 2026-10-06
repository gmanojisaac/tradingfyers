const http = require('http');
const cfg = require('./src/config');
const logger = require('./src/logger');
const { createClient, fetchCandles } = require('./src/fyers');
const { DateTime } = require('luxon');
const { nowIst, minuteOfDay, fmt, dayKey } = require('./src/time');
const AnchoredVwap = require('./src/vwap');
const { simulate, summarize } = require('./src/backtest');
const { simulateReverse } = require('./src/reverse');

const PORT = Number(process.env.CHART_PORT) || 3000;
const SYMBOLS = { index: 'NSE:NIFTY50-INDEX', fut: cfg.symbol };

const peak = (t, data) => {
  const span = data.filter((c) => c.ts >= t.entryTs && c.ts <= t.exitTs);
  const best = t.side === 'LONG'
    ? Math.max(...span.map((c) => c.high)) - t.entryPrice
    : t.entryPrice - Math.min(...span.map((c) => c.low));
  return +Math.max(best, 0).toFixed(2);
};

// Day target: NET profit in points (realised points of earlier closed trades + the open trade's profit).
// The first candle where that net reaches `target` ends the day. The trade that hit it exits at the level
// (or the open on a gap); other open trades exit at that candle's close; later trades are dropped.
// Strategies are causal, so cutting their trade list at that candle is exact.
function applyDayTarget(trades, data, target, label = 'DAY_TARGET') {
  const dir = (t) => (t.side === 'LONG' ? 1 : -1);
  const active = (t, c) => t.entryTs <= c.ts && t.exitTs >= c.ts;
  const realised = (c) => trades.filter((t) => t.exitTs < c.ts).reduce((s, t) => s + t.points, 0);
  const unreal = (t, price) => (price - t.entryPrice) * dir(t);
  // net if only trade `t` reaches its best price in candle c; other open trades are marked at the open
  const baseFor = (t, c) => realised(c) + trades.filter((o) => o !== t && active(o, c)).reduce((s, o) => s + unreal(o, c.open), 0);
  const best = (t, c) => (t.side === 'LONG' ? c.high : c.low);
  const hit = (t, c) => baseFor(t, c) + unreal(t, best(t, c)) >= target;
  const trigger = data.find((c) => trades.some((t) => active(t, c) && hit(t, c)));
  if (!trigger) return { trades, targetTs: null };
  const out = [];
  for (const t of trades) {
    if (t.entryTs > trigger.ts) continue;
    if (t.exitTs < trigger.ts) {
      out.push(t);
      continue;
    }
    const hits = hit(t, trigger);
    let price = trigger.close;
    if (hits) {
      const level = t.entryPrice + dir(t) * (target - baseFor(t, trigger));
      price = dir(t) * (trigger.open - level) >= 0 ? trigger.open : level;
    }
    const points = +unreal(t, price).toFixed(2);
    out.push({
      ...t,
      exitTs: trigger.ts,
      exitTime: fmt(trigger.ts),
      exitPrice: +price.toFixed(2),
      exitReason: hits ? label : `${label}_CLOSE`,
      points,
      pnl: +(points * cfg.qty - cfg.costPerTrade).toFixed(2),
    });
  }
  return { trades: out, targetTs: trigger.ts };
}

function aggregate(candles, minutes) {
  if (minutes <= 1) return candles;
  const size = minutes * 60;
  const out = new Map();
  for (const c of candles) {
    const ts = Math.floor(c.ts / size) * size;
    const b = out.get(ts);
    if (!b) out.set(ts, { ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

// Indices carry no volume, so weight candles equally to keep VWAP meaningful.
// options.holdOvernight: multi-day run - no EOD square-off, positions carry across days.
function analyse(candles, strategy, target = 0, tf = 1, options = {}) {
  const sess = aggregate(candles.filter((c) => minuteOfDay(c.ts) >= cfg.sessionStartMin && minuteOfDay(c.ts) < cfg.sessionEndMin), tf);
  const noVolume = sess.every((c) => !(c.volume > 0));
  const data = noVolume ? sess.map((c) => ({ ...c, volume: 1 })) : sess;
  const vw = new AnchoredVwap(cfg.bandMultiplier);
  let curDay = null;
  const bands = data.map((c) => {
    const d = dayKey(c.ts);
    if (d !== curDay) {
      curDay = d;
      vw.reset(); // VWAP is anchored to each day's open
    }
    const b = vw.update(c);
    return { ts: c.ts, vwap: b.vwap, upper: b.upper, lower: b.lower };
  });
  let { trades } = (strategy === 'reverse' ? simulateReverse : simulate)(data, {
    weeklyProfitTarget: target > 0 ? target : 1e12,
    holdOvernight: !!options.holdOvernight,
  });
  let targetTs = null;
  if (target > 0) ({ trades, targetTs } = applyDayTarget(trades, data, target, options.targetLabel));
  for (const t of trades) t.maxProfit = peak(t, data);
  const summary = summarize(trades, cfg.qty);
  for (const t of trades) {
    const n = t.maxProfit + trades.filter((p) => p !== t && p.exitTs <= t.entryTs).reduce((s, p) => s + p.points, 0);
    t.maxNet = +(target > 0 ? Math.min(n, target) : n).toFixed(2);
  }
  summary.bestMaxNet = trades.length ? Math.max(...trades.map((t) => t.maxNet)) : 0;
  return { candles: sess, bands, trades, summary, equalWeighted: noVolume, targetTs };
}

// Whole week as one multi-day run: positions are held overnight (no EOD exit) and close only on their signal,
// the weekly target, or the last candle of the week. After the target is hit, no further trades are taken.
function analyseWeek(candles, days, strategy, target, tf) {
  const r = analyse(candles, strategy, target, tf, { holdOvernight: true, targetLabel: 'WEEKLY_TARGET' });
  const lockDay = r.targetTs ? dayKey(r.targetTs) : null;
  let cum = 0;
  const rows = days.map((day) => {
    const ts = r.trades.filter((t) => dayKey(t.exitTs) === day);
    const points = +ts.reduce((s, t) => s + t.points, 0).toFixed(2);
    cum += points;
    return { day, trades: ts.length, points, skipped: !!lockDay && day > lockDay, cumPoints: +cum.toFixed(2) };
  });
  return { ...r, days: rows };
}
const OFFSET = 19800; // chart axis shows IST

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>NIFTY 50 - 1 min</title>
<script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<style>body{margin:0;background:#131722;color:#d1d4dc;font-family:sans-serif}#bar{padding:6px}#c{height:70vh;width:100%}table.t{border-collapse:collapse;margin:8px;font-size:13px}.t th,.t td{border:1px solid #333;padding:3px 8px;text-align:right}.t th{background:#1e222d}.w{color:#26a69a}.l{color:#ef5350}input,button{margin-left:6px}</style></head><body>
<div id="bar">NIFTY 50 (IST)
  <select id="strat"><option value="normal">Strategy: VWAP bands</option><option value="reverse">Strategy: Reverse &amp; recover</option></select>
  <select id="tf"><option value="1">1 min</option><option value="5" selected>5 min</option></select>
  <select id="view"><option value="day">View: Day</option><option value="week">View: Week (Mon-Fri)</option></select>
  <select id="sym"><option value="index">NIFTY 50 index</option><option value="fut">Futures (SYMBOL)</option></select>
  <input type="date" id="d"><button id="go">Load</button>
  <label>Day target net pts <input type="number" id="tgt" value="100" min="0" style="width:60px"></label>
  <label><input type="checkbox" id="auto" checked> auto-refresh 30s</label> <span id="msg"></span></div>
<div id="c"></div>
<table class="t" id="trades"></table>
<script>
const chart = LightweightCharts.createChart(document.getElementById('c'), {
  autoSize: true,
  layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
  grid: { vertLines: { color: '#222' }, horzLines: { color: '#222' } },
  timeScale: { timeVisible: true },
});
// Week view puts candles on a compressed axis (no overnight/weekend gaps); realTs maps axis slots back to real times.
let realTs = null;
const pad = n => String(n).padStart(2, '0');
function label(tm, withDate) {
  const real = realTs ? realTs[Math.round(tm / 60)] : tm - ${OFFSET};
  if (real === undefined) return '';
  const d = new Date((real + ${OFFSET}) * 1000);
  const hm = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  return withDate || realTs ? pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + hm : hm;
}
chart.applyOptions({
  timeScale: { tickMarkFormatter: tm => label(tm, false) },
  localization: { timeFormatter: tm => label(tm, true) },
});
const series = chart.addCandlestickSeries();
const line = (color, style) => chart.addLineSeries({ color, lineWidth: 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false });
const vwapS = line('#f5c542', 0), upS = line('#2196f3', 2), loS = line('#2196f3', 2);
const msg = document.getElementById('msg');
const dateEl = document.getElementById('d');
const symEl = document.getElementById('sym');
const stratEl = document.getElementById('strat');
const tgtEl = document.getElementById('tgt');
const tfEl = document.getElementById('tf');
const viewEl = document.getElementById('view');
async function load(fit) {
  msg.textContent = 'loading...';
  try {
    const q = new URLSearchParams({ symbol: symEl.value, strategy: stratEl.value, target: tgtEl.value || '0', tf: tfEl.value });
    if (dateEl.value) q.set('date', dateEl.value);
    const week = viewEl.value === 'week';
    const r = await fetch((week ? '/api/week?' : '/api/candles?') + q);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    dateEl.value = j.date;
    let t = ts => ts + ${OFFSET};
    realTs = null;
    if (week) {
      realTs = j.candles.map(c => c.ts);
      const slot = new Map(realTs.map((ts, i) => [ts, i * 60]));
      t = ts => {
        if (slot.has(ts)) return slot.get(ts);
        let i = realTs.findIndex(x => x >= ts);
        return (i < 0 ? realTs.length - 1 : i) * 60;
      };
    }
    series.setData(j.candles.map(c => ({ time: t(c.ts), open: c.open, high: c.high, low: c.low, close: c.close })));
    vwapS.setData(j.bands.map(b => ({ time: t(b.ts), value: b.vwap })));
    upS.setData(j.bands.map(b => ({ time: t(b.ts), value: b.upper })));
    loS.setData(j.bands.map(b => ({ time: t(b.ts), value: b.lower })));
    const m = [];
    for (const tr of j.trades) {
      const long = tr.side === 'LONG';
      m.push({ time: t(tr.entryTs), position: long ? 'belowBar' : 'aboveBar', color: long ? '#26a69a' : '#ef5350', shape: long ? 'arrowUp' : 'arrowDown', text: tr.side + ' ' + tr.entryPrice });
      m.push({ time: t(tr.exitTs), position: long ? 'aboveBar' : 'belowBar', color: '#aaa', shape: 'circle', text: tr.exitReason + ' ' + tr.points + 'pts' });
    }
    series.setMarkers(m.sort((a, b) => a.time - b.time));
    const rows = j.trades.map((tr, i) => '<tr><td>' + (i + 1) + '</td><td>' + tr.side + '</td><td>' + (tr.leg || '-') + '</td><td>' + tr.entryTime.slice(week ? 5 : 11) + '</td><td>' + tr.entryPrice + '</td><td>' + tr.exitTime.slice(week ? 5 : 11) + '</td><td>' + tr.exitPrice + '</td><td>' + tr.exitReason + '</td><td class="' + (tr.points > 0 ? 'w' : 'l') + '">' + tr.points + '</td><td class="w">' + tr.maxNet + '</td></tr>').join('');
    document.getElementById('trades').innerHTML = '<tr><th>#</th><th>Side</th><th>Leg</th><th>Entry time</th><th>Entry</th><th>Exit time</th><th>Exit</th><th>Reason</th><th>Points</th><th>Max Net Profit (pts)</th></tr>' + (rows || '<tr><td colspan="10">No trades</td></tr>');
    if (fit) chart.timeScale().fitContent();
    const s = j.summary;
    const daysTxt = week ? j.days.map(d => d.day.slice(5) + ': ' + (d.skipped ? 'locked' : d.points + ' pts')).join(', ') + ' | ' : '';
    msg.textContent = daysTxt + j.candles.length + ' candles | trades ' + s.totalTrades + ' (W ' + s.wins + '/L ' + s.losses + '), ' + s.totalPoints + ' pts | NET P&L Rs ' + s.totalPnl + ' (qty ' + s.qty + ')' + (j.targetTs ? ' | ' + (week ? 'weekly' : 'day') + ' target hit ' + new Date((j.targetTs + 19800) * 1000).toISOString().slice(11, 16) : '') + ' | best max net profit ' + s.bestMaxNet + ' pts' + (j.equalWeighted ? ' | no volume: equal-weighted VWAP' : '') + ' | ' + new Date().toLocaleTimeString();
  } catch (e) { msg.textContent = 'Error: ' + e.message; }
}
symEl.onchange = () => load(true);
stratEl.onchange = () => load(true);
tgtEl.onchange = () => load(true);
tfEl.onchange = () => load(true);
viewEl.onchange = () => load(true);
document.getElementById('go').onclick = () => load(true);
setInterval(() => { if (document.getElementById('auto').checked) load(false); }, 30000);
load(true);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (url.pathname === '/api/week') {
    const date = url.searchParams.get('date') || nowIst().toFormat('yyyy-LL-dd');
    res.setHeader('Content-Type', 'application/json');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'date must be YYYY-MM-DD' }));
    }
    try {
      const key = url.searchParams.get('symbol') === 'fut' ? 'fut' : 'index';
      const monday = DateTime.fromISO(date, { zone: cfg.zone }).startOf('week');
      const today = nowIst().startOf('day');
      const days = [0, 1, 2, 3, 4].map((i) => monday.plus({ days: i })).filter((d) => d <= today).map((d) => d.toFormat('yyyy-LL-dd'));
      if (!days.length) throw new Error('that week has not started yet');
      const candles = await fetchCandles(createClient(), SYMBOLS[key], days[0], days[days.length - 1], 1);
      const target = Number(url.searchParams.get('target')) || 0;
      const tf = Number(url.searchParams.get('tf')) || 1;
      res.writeHead(200);
      return res.end(JSON.stringify({ date, symbol: SYMBOLS[key], ...analyseWeek(candles, days, url.searchParams.get('strategy'), target, tf) }));
    } catch (e) {
      logger.error(`[CHART] ${e.message}`);
      res.writeHead(500);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  if (url.pathname === '/api/candles') {
    const date = url.searchParams.get('date') || nowIst().toFormat('yyyy-LL-dd');
    res.setHeader('Content-Type', 'application/json');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'date must be YYYY-MM-DD' }));
    }
    try {
      const key = url.searchParams.get('symbol') === 'fut' ? 'fut' : 'index';
      const candles = await fetchCandles(createClient(), SYMBOLS[key], date, date, 1);
      res.writeHead(200);
      return res.end(JSON.stringify({ date, symbol: SYMBOLS[key], ...analyse(candles, url.searchParams.get('strategy'), Number(url.searchParams.get('target')) || 0, Number(url.searchParams.get('tf')) || 1) }));
    } catch (e) {
      logger.error(`[CHART] ${e.message}`);
      res.writeHead(500);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  res.writeHead(404);
  res.end('Not found');
});

// bound to loopback only: the endpoint uses your FYERS token
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => console.log(`NIFTY chart at http://localhost:${PORT}`));
}
module.exports = { analyse, analyseWeek, aggregate };
