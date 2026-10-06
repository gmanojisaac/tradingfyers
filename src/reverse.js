const cfg = require('./config');
const VwapBandStrategy = require('./strategy');
const { summarize } = require('./backtest');
const { fmt, dayKey, minuteOfDay } = require('./time');

const dirOf = (side) => (side === 'LONG' ? 1 : -1);
const opposite = (side) => (side === 'LONG' ? 'SHORT' : 'LONG');

/**
 * Reverse-and-recover strategy.
 * 1. The first trade comes from the normal VWAP-band setup (one at a time).
 * 2. If it exits at a loss on its signal at price X (entry E), the opposite side is opened at X.
 * 3. When price returns to E: close the reverse trade and re-enter the first side at E,
 *    with a stop at X (same loss distance as the original loss).
 * 4. If that stop is hit, reverse again at X. After maxReversals flips the cycle ends.
 * Levels are checked against each candle's range; only one transition happens per candle.
 * A gap through a level fills at the candle open. Everything is closed at the 15:25 EOD exit.
 */
function simulateReverse(candles, options = {}) {
  const qty = options.qty ?? cfg.qty;
  const slip = options.slippagePoints ?? cfg.slippagePoints;
  const cost = options.costPerTrade ?? cfg.costPerTrade;
  const maxFlips = options.maxReversals ?? cfg.maxReversals;
  const strat = new VwapBandStrategy(options);
  const trades = [];
  let cyc = null; // {mode: FIRST|REVERSE|RETRY, first, E, X, flips}
  let leg = null;
  let prev = null;

  const openLeg = (side, price, ts, kind) => {
    leg = { side, kind, entryTs: ts, entryPrice: price + dirOf(side) * slip };
  };

  const closeLeg = (ts, price, reason) => {
    const dir = dirOf(leg.side);
    const exitPrice = price - dir * slip;
    const points = (exitPrice - leg.entryPrice) * dir;
    trades.push({
      side: leg.side,
      leg: leg.kind,
      entryTs: leg.entryTs,
      exitTs: ts,
      entryTime: fmt(leg.entryTs),
      entryPrice: leg.entryPrice,
      exitTime: fmt(ts),
      exitPrice,
      exitReason: reason,
      points: +points.toFixed(2),
      pnl: +(points * qty - cost).toFixed(2),
    });
    leg = null;
  };

  const endCycle = () => {
    if (cyc && strat.state[cyc.first].position) strat.applyFill({ type: 'EXIT', side: cyc.first });
    cyc = null;
    strat.resetMemory();
  };

  const step = (c) => {
    const up = cyc.first === 'LONG';
    if (cyc.mode === 'REVERSE') {
      if (!(up ? c.high >= cyc.E : c.low <= cyc.E)) return;
      const fill = up ? Math.max(cyc.E, c.open) : Math.min(cyc.E, c.open);
      closeLeg(c.ts, fill, 'REVERSE_STOP');
      openLeg(cyc.first, fill, c.ts, 'RETRY');
      cyc.mode = 'RETRY';
    } else {
      if (!(up ? c.low <= cyc.X : c.high >= cyc.X)) return;
      const fill = up ? Math.min(cyc.X, c.open) : Math.max(cyc.X, c.open);
      closeLeg(c.ts, fill, 'STOP');
      if (cyc.flips >= maxFlips) {
        endCycle();
      } else {
        cyc.flips++;
        openLeg(opposite(cyc.first), fill, c.ts, 'REVERSE');
        cyc.mode = 'REVERSE';
      }
    }
  };

  for (const c of candles) {
    if (!options.holdOvernight && cyc && prev && dayKey(prev.ts) !== dayKey(c.ts)) {
      closeLeg(prev.ts, prev.close, 'EOD');
      endCycle();
    }

    if (cyc && cyc.mode !== 'FIRST') {
      if (!options.holdOvernight && minuteOfDay(c.ts) >= cfg.eodExitMin) {
        closeLeg(c.ts, c.open, 'EOD');
        endCycle();
      } else {
        step(c);
      }
      strat.onClose(c); // keep VWAP current; its actions are ignored during a cycle
      prev = c;
      continue;
    }

    for (const a of strat.onOpen({ ts: c.ts, open: c.open })) {
      if (a.type === 'ENTER' && !strat.hasPosition()) {
        strat.applyFill(a, a.price);
        openLeg(a.side, a.price, a.ts, 'FIRST');
        cyc = { mode: 'FIRST', first: a.side, E: a.price, X: null, flips: 0 };
      } else if (a.type === 'EXIT' && cyc && a.side === cyc.first) {
        closeLeg(c.ts, a.price, a.reason);
        endCycle();
      }
    }

    for (const b of strat.onClose(c)) {
      if (b.type === 'EXIT' && cyc && cyc.mode === 'FIRST' && b.side === cyc.first) {
        closeLeg(b.ts, b.price, b.reason);
        strat.applyFill(b);
        const loss = (cyc.E - b.price) * dirOf(cyc.first);
        if (loss > 0) {
          cyc.mode = 'REVERSE';
          cyc.X = b.price;
          openLeg(opposite(cyc.first), b.price, b.ts, 'REVERSE');
        } else {
          cyc = null;
        }
      }
    }
    prev = c;
  }

  if (leg && prev) closeLeg(prev.ts, prev.close, 'END_OF_DATA');
  return { trades, summary: summarize(trades, qty) };
}

module.exports = { simulateReverse };
