const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DateTime } = require('luxon');
const WeeklyProfitGuard = require('../src/weekly-profit');
const { simulate } = require('../src/backtest');

const ts = (day, hour = 10, minute = 0) => DateTime.fromObject(
  { year: 2026, month: 9, day, hour, minute },
  { zone: 'Asia/Kolkata' },
).toSeconds();
const candle = (day, hour, minute, open, high, low, close, volume = 100) => ({
  ts: ts(day, hour, minute),
  open,
  high,
  low,
  close,
  volume,
});

test('weekly target locks until next Monday even if closing positions reduces net P&L', () => {
  const guard = new WeeklyProfitGuard({ target: 100, initialTs: ts(15) });

  assert.equal(guard.record(20, ts(15)), false);
  assert.equal(guard.checkTarget(80, ts(15)), true);
  assert.equal(guard.record(-80, ts(15)), true);
  assert.equal(guard.netPnl, -60);
  assert.equal(guard.isLocked(ts(18)), true);
  assert.equal(guard.isLocked(ts(21)), false);
  assert.equal(guard.netPnl, 0);
});

test('weekly P&L and lock persist across restarts and reset on Monday', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-profit-'));
  const filePath = path.join(dir, 'weekly-pnl.json');

  try {
    const first = new WeeklyProfitGuard({ target: 100, filePath, initialTs: ts(15) });
    first.record(125, ts(15));

    const restarted = new WeeklyProfitGuard({ target: 100, filePath, initialTs: ts(18) });
    assert.equal(restarted.netPnl, 125);
    assert.equal(restarted.isLocked(ts(18)), true);

    assert.equal(restarted.isLocked(ts(21)), false);
    const nextRestart = new WeeklyProfitGuard({ target: 100, filePath, initialTs: ts(21) });
    assert.equal(nextRestart.netPnl, 0);
    assert.equal(nextRestart.locked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('holdOvernight keeps a position open across days instead of squaring off at 15:25', () => {
  const day2 = (h, m, o, hi, l, cl) => candle(16, h, m, o, hi, l, cl);
  const candles = [
    candle(15, 9, 15, 100, 101, 99, 100),
    candle(15, 9, 16, 99, 100.5, 98, 99),
    candle(15, 9, 17, 97, 99, 96, 98), // long setup
    candle(15, 9, 18, 99, 100, 98, 99.5), // long entry
    candle(15, 15, 25, 102, 103, 101, 102),
    day2(9, 15, 103, 104, 102, 103),
    day2(15, 25, 105, 106, 104, 105),
  ];
  const intraday = simulate(candles, { qty: 1 }).trades;
  assert.equal(intraday[0].exitReason, 'EOD');
  const multi = simulate(candles, { qty: 1, holdOvernight: true }).trades;
  assert.equal(multi.length, 1);
  assert.equal(multi[0].exitReason, 'END_OF_DATA');
  assert.ok(multi[0].exitTs > ts(15, 23, 59), 'exit is on the next day');
});

test('backtest locks for the week after reaching target and closes the other open side', () => {
  const candles = [
    candle(15, 9, 15, 100, 101, 99, 100),
    candle(15, 9, 16, 99, 100.5, 98, 99),
    candle(15, 9, 17, 97, 99, 96, 98),
    candle(15, 9, 18, 99, 100, 98, 99.5),
    candle(15, 9, 19, 99.5, 100, 99, 99.8),
    candle(15, 9, 20, 98, 98.1, 97.4, 97.5, 1),
    candle(15, 9, 21, 97.4, 97.8, 97.3, 97.45),
    candle(15, 15, 25, 105, 106, 104, 105),
    candle(16, 9, 15, 100, 101, 99, 100),
    candle(16, 9, 16, 99, 100.5, 98, 99),
    candle(16, 9, 17, 97, 99, 96, 98),
    candle(16, 9, 18, 99, 100, 98, 99.5),
    candle(16, 15, 25, 105, 106, 104, 105),
  ];

  const { trades } = simulate(candles, { qty: 75, weeklyProfitTarget: 5 });

  assert.equal(trades.length, 2);
  assert.equal(trades[0].side, 'LONG');
  assert.equal(trades[1].side, 'SHORT');
  assert.equal(trades[1].exitReason, 'WEEKLY_TARGET');
});
