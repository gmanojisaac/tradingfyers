const fs = require('fs');
const path = require('path');
const { dayKey, weekKey } = require('./src/time');
const cfg = require('./src/config');
const { analyseWeek } = require('./chart-server');

const FROM = process.argv[2] || '2025-01-01';
const TO = process.argv[3] || '2026-10-06';
const TARGET = Number(process.env.WEEKLY_TARGET ?? cfg.weeklyProfitTarget);
const TF = Number(process.env.TF ?? 5);
const CACHE = path.join(__dirname, 'output', `nifty_1m_${FROM}_${TO}.json`);

const candles = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const byWeek = new Map();
for (const c of candles) {
  const k = weekKey(c.ts);
  if (!byWeek.has(k)) byWeek.set(k, []);
  byWeek.get(k).push(c);
}

const out = {};
for (const strategy of ['normal', 'reverse']) {
  const months = {};
  for (const [week, cs] of [...byWeek].sort()) {
    const days = [...new Set(cs.map((c) => dayKey(c.ts)))].sort();
    const r = analyseWeek(cs, days, strategy, TARGET, TF);
    const hit = !!r.targetTs;
    for (const t of r.trades) {
      const m = t.exitTime.slice(0, 7);
      const row = (months[m] ||= { trades: 0, points: 0, pnl: 0, weeks: new Set(), targetWeeks: new Set() });
      row.trades++;
      row.points += t.points;
      row.pnl += t.pnl;
      row.weeks.add(week);
      if (hit) row.targetWeeks.add(week);
    }
  }
  out[strategy] = months;
}

for (const strategy of Object.keys(out)) {
  console.log(`\n## ${strategy} (${TF}-min, weekly target ${TARGET} pts, multi-day, qty ${cfg.qty})`);
  console.log('Month | Trades | Weeks traded | Target weeks | Points | Net P&L (Rs)');
  const years = {};
  for (const [m, r] of Object.entries(out[strategy]).sort()) {
    console.log(`${m} | ${r.trades} | ${r.weeks.size} | ${r.targetWeeks.size} | ${r.points.toFixed(2)} | ${r.pnl.toFixed(2)}`);
    const y = (years[m.slice(0, 4)] ||= { pnl: 0, points: 0 });
    y.pnl += r.pnl;
    y.points += r.points;
  }
  for (const [y, r] of Object.entries(years)) console.log(`${y} TOTAL | | | | ${r.points.toFixed(2)} | ${r.pnl.toFixed(2)}`);
}
