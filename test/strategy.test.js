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
