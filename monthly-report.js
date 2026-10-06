const fs = require('fs');
const path = require('path');
const { createClient, fetchCandles } = require('./src/fyers');
const { dayKey } = require('./src/time');
const cfg = require('./src/config');
const { analyse } = require('./chart-server');

const SYMBOL = 'NSE:NIFTY50-INDEX';
const FROM = process.argv[2] || '2025-01-01';
const TO = process.argv[3] || new Date().toISOString().slice(0, 10);
const TARGET = Number(process.env.DAY_TARGET ?? 100);
const TF = Number(process.env.TF ?? 5);
const CACHE = path.join(__dirname, 'output', `nifty_1m_${FROM}_${TO}.json`);

(async () => {
  let candles;
  if (fs.existsSync(CACHE)) {
    candles = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } else {
    candles = await fetchCandles(createClient(), SYMBOL, FROM, TO);
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(candles));
  }
  console.log(`${candles.length} candles, ${FROM} -> ${TO}`);

  const byDay = new Map();
  for (const c of candles) {
    const k = dayKey(c.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(c);
  }

  const out = {};
  for (const strategy of ['normal', 'reverse']) {
    const months = {};
    for (const [day, cs] of [...byDay].sort()) {
      const r = analyse(cs, strategy, TARGET, TF);
      const m = day.slice(0, 7);
      const row = (months[m] ||= { days: 0, trades: 0, points: 0, pnl: 0, targetDays: 0 });
      row.days++;
      row.trades += r.summary.totalTrades;
      row.points += r.summary.totalPoints;
      row.pnl += r.summary.totalPnl;
      if (r.targetTs) row.targetDays++;
    }
    out[strategy] = months;
  }
  fs.writeFileSync(path.join(__dirname, 'output', 'monthly_report.json'), JSON.stringify(out, null, 2));

  for (const strategy of Object.keys(out)) {
    console.log(`\n## ${strategy} (${TF}-min, day target ${TARGET}, qty ${cfg.qty})`);
    console.log('Month | Days | Trades | Target days | Points | Net P&L (Rs)');
    const years = {};
    for (const [m, r] of Object.entries(out[strategy])) {
      console.log(`${m} | ${r.days} | ${r.trades} | ${r.targetDays} | ${r.points.toFixed(2)} | ${r.pnl.toFixed(2)}`);
      const y = (years[m.slice(0, 4)] ||= { pnl: 0, points: 0 });
      y.pnl += r.pnl;
      y.points += r.points;
    }
    for (const [y, r] of Object.entries(years)) console.log(`${y} TOTAL | | | | ${r.points.toFixed(2)} | ${r.pnl.toFixed(2)}`);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
