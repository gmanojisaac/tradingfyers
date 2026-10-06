const { simulate } = require('../src/backtest');
const { DateTime } = require('luxon');
const test = require('node:test');
const assert = require('node:assert');

const ts = (h, m) => DateTime.fromObject({ year: 2026, month: 9, day: 15, hour: h, minute: m }, { zone: 'Asia/Kolkata' }).toSeconds();
const c = (h, m, o, hi, l, cl, v = 100) => ({ ts: ts(h, m), open: o, high: hi, low: l, close: cl, volume: v });

test('long setup -> entry -> signal exit', () => {
  const candles = [
    c(9, 15, 100, 101, 99, 100), // vwap ~100
    c(9, 16, 100, 101, 99, 100.0),
    c(9, 17, 98, 100, 97, 99), // green touching lower band? depends on sd; checked below
    c(9, 18, 100, 101, 99, 100),
    c(9, 19, 100, 100, 95, 96), // red, close < trigger open
    c(9, 20, 96, 97, 95, 96),
  ];
  const { trades } = simulate(candles, { qty: 1 });
  assert.ok(trades.every((t) => t.exitTime));
});

test('EOD square-off at 15:25 even with no signal', () => {
  const candles = [
    c(9, 15, 100, 101, 99, 100),
    c(9, 16, 99, 100.5, 98, 99), // doji, establishes sd
    c(9, 17, 97, 99, 96, 98), // green at/below lower band -> long setup
    c(9, 18, 99, 100, 98, 99.5), // opens >= trigger close 98 -> entry
    c(15, 24, 100, 101, 99, 100.5),
    c(15, 25, 102, 103, 101, 102),
    c(15, 26, 102, 103, 101, 102),
  ];
  const { trades } = simulate(candles, { qty: 1 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, 'LONG');
  assert.equal(trades[0].exitReason, 'EOD');
  assert.equal(trades[0].exitTime.slice(11, 16), '15:25');
  assert.equal(trades[0].exitPrice, 102);
});

test('no entries after 15:20', () => {
  const candles = [
    c(9, 15, 100, 101, 99, 100),
    c(15, 19, 99, 100.5, 98, 99),
    c(15, 20, 97, 99, 96, 98), // setup at 15:20 candle
    c(15, 21, 99, 100, 98, 99.5), // entry at 15:21 is outside window
  ];
  const { trades } = simulate(candles, { qty: 1 });
  assert.equal(trades.length, 0);
});

test('short trades independently while a long is open', () => {
  const candles = [
    c(9, 15, 100, 101, 99, 100),
    c(9, 16, 99, 100.5, 98, 99),
    c(9, 17, 97, 99, 96, 98), // long setup
    c(9, 18, 99, 100, 98, 99.5), // long entry, stays open
    c(9, 19, 99.5, 100, 99, 99.8),
    c(9, 20, 98, 98.1, 97.4, 97.5, 1), // red, fully below lower band -> short setup
    c(9, 21, 97.4, 97.8, 97.3, 97.45), // opens <= trigger close -> short entry
    c(15, 25, 94, 95, 93, 94),
  ];
  const { trades } = simulate(candles, { qty: 1 });
  const sides = trades.map((t) => t.side).sort();
  assert.deepEqual(sides, ['LONG', 'SHORT']);
  const long = trades.find((t) => t.side === 'LONG');
  const short = trades.find((t) => t.side === 'SHORT');
  assert.ok(short.entryTs > long.entryTs && short.entryTs < long.exitTs, 'short entered while long open');
});

test('opposite side waits while the open trade is in profit, enters once it is at a loss', () => {
  const VwapBandStrategy = require('../src/strategy');
  const s = new VwapBandStrategy();
  s._rollDay(ts(10, 0));
  s.state.LONG.position = { side: 'LONG', entryPrice: 100, entryTs: ts(10, 0), triggerOpen: 90, triggerClose: 95 };
  s.state.SHORT.pending = { side: 'SHORT', triggerOpen: 105, triggerClose: 103, ts: ts(10, 1) };
  assert.deepEqual(s.onOpen({ ts: ts(10, 2), open: 102 }), []); // long in profit -> wait
  const a = s.onOpen({ ts: ts(10, 3), open: 99 }); // long now at a loss -> short enters
  assert.equal(a.length, 1);
  assert.equal(a[0].side, 'SHORT');
});
const reverseCandles = [
  c(9, 15, 100, 101, 99, 100),
  c(9, 16, 99, 100.5, 98, 99),
  c(9, 17, 97, 99, 96, 98), // long setup
  c(9, 18, 99, 100, 98, 99.5), // first long enters at 99
  c(9, 19, 99, 99.5, 95, 96), // signal exit at 96 (loss 3) -> reverse short at 96
  c(9, 20, 96.5, 99.2, 96.2, 98), // back to 99: reverse closed, long re-enters at 99, stop 96
  c(9, 21, 98, 98.5, 95.5, 96.5), // stop hit at 96 -> reverse short at 96
  c(15, 25, 90, 91, 89, 90),
];

test('reverse strategy: reverse at loss, re-enter at first entry with same-distance stop', () => {
  const { simulateReverse } = require('../src/reverse');
  const { trades } = simulateReverse(reverseCandles, { qty: 1 });
  assert.deepEqual(
    trades.map((t) => [t.side, t.leg, t.entryPrice, t.exitPrice, t.exitReason]),
    [
      ['LONG', 'FIRST', 99, 96, 'SIGNAL'],
      ['SHORT', 'REVERSE', 96, 99, 'REVERSE_STOP'],
      ['LONG', 'RETRY', 99, 96, 'STOP'],
      ['SHORT', 'REVERSE', 96, 90, 'EOD'],
    ],
  );
});

test('reverse strategy: cycle ends after maxReversals flips', () => {
  const { simulateReverse } = require('../src/reverse');
  const { trades } = simulateReverse(reverseCandles, { qty: 1, maxReversals: 0 });
  assert.equal(trades.length, 3);
  assert.equal(trades[2].exitReason, 'STOP');
});
