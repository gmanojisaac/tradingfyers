const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const logger = require('./logger');
const VwapBandStrategy = require('./strategy');
const { createClient, fetchCandles } = require('./fyers');
const { fmt, dayKey, minuteOfDay } = require('./time');
const WeeklyProfitGuard = require('./weekly-profit');

function simulate(candles, options = {}) {
  const strat = new VwapBandStrategy(options);
  const qty = options.qty ?? cfg.qty;
  const slip = options.slippagePoints ?? cfg.slippagePoints;
  const cost = options.costPerTrade ?? cfg.costPerTrade;
  const weeklyProfit = new WeeklyProfitGuard({
    target: options.weeklyProfitTarget ?? cfg.weeklyProfitTarget,
    initialTs: candles[0]?.ts ?? Math.floor(Date.now() / 1000),
  });
  const trades = [];
  const opens = { LONG: null, SHORT: null };

  const exit = (action, price, forceClose = true) => {
    const open = opens[action.side];
    if (!open) return;
    const dir = open.side === 'LONG' ? 1 : -1;
    const exitPrice = price - dir * slip;
    const points = (exitPrice - open.entryPrice) * dir;
    trades.push({
      side: open.side,
      entryTs: open.entryTs,
      exitTs: action.ts,
      entryTime: fmt(open.entryTs),
      entryPrice: open.entryPrice,
      triggerOpen: open.triggerOpen,
      triggerClose: open.triggerClose,
      exitTime: fmt(action.ts),
      exitPrice,
      exitReason: action.reason,
      points: +points.toFixed(2),
      pnl: +(points * qty - cost).toFixed(2),
    });
    strat.applyFill(action, exitPrice);
    logger.info(`[BT] EXIT ${open.side} ${action.reason} @ ${exitPrice} pnl=${points.toFixed(2)}pts`);
    opens[action.side] = null;
    weeklyProfit.record(points - cost / qty, action.ts);
    if (forceClose && weeklyProfit.isLocked(action.ts)) {
      for (const side of ['LONG', 'SHORT']) {
        if (opens[side]) {
          exit({ type: 'EXIT', side, reason: 'WEEKLY_TARGET', ts: action.ts }, price, false);
        }
      }
    }
  };

  const estimateOpenPnl = (price) => ['LONG', 'SHORT'].reduce((total, side) => {
    const open = opens[side];
    if (!open) return total;
    const direction = open.side === 'LONG' ? 1 : -1;
    return total + (price - open.entryPrice) * direction - cost / qty;
  }, 0);

  const closeAtWeeklyTarget = (price, ts) => {
    if (!weeklyProfit.checkTarget(estimateOpenPnl(price), ts)) return;
    for (const side of ['LONG', 'SHORT']) {
      if (opens[side]) exit({ type: 'EXIT', side, reason: 'WEEKLY_TARGET', ts }, price);
    }
  };

  const handle = (a) => {
    if (weeklyProfit.isLocked(a.ts) && (a.type === 'ENTER' || a.type === 'SETUP')) {
      strat.resetMemory();
      return;
    }
    if (a.type === 'ENTER') {
      const dir = a.side === 'LONG' ? 1 : -1;
      const price = a.price + dir * slip;
      strat.applyFill(a, price);
      opens[a.side] = { ...strat.state[a.side].position };
      logger.info(`[BT] ENTRY ${a.side} @ ${price} (${fmt(a.ts)})`);
    } else if (a.type === 'EXIT') {
      exit(a, a.price);
    } else if (a.type === 'SETUP') {
      logger.info(`[BT] SETUP ${a.side} ${fmt(a.ts)} open=${a.triggerOpen} close=${a.triggerClose}`);
    }
  };

  let prev = null;
  for (const c of candles) {
    weeklyProfit.isLocked(c.ts);
    // day rolled over with open positions (missing EOD candle): flatten at last known close
    if (!options.holdOvernight && prev && dayKey(prev.ts) !== dayKey(c.ts)) {
      for (const side of ['LONG', 'SHORT']) {
        if (opens[side]) exit({ type: 'EXIT', side, reason: 'EOD', ts: prev.ts }, prev.close);
      }
    }

    closeAtWeeklyTarget(c.open, c.ts);
    strat.onOpen({ ts: c.ts, open: c.open }).forEach(handle);
    strat.onClose(c).forEach(handle);
    closeAtWeeklyTarget(c.close, c.ts);
    if (weeklyProfit.isLocked(c.ts)) strat.resetMemory();

    prev = c;
  }
  for (const side of ['LONG', 'SHORT']) {
    if (opens[side] && prev) exit({ type: 'EXIT', side, reason: 'END_OF_DATA', ts: prev.ts }, prev.close);
  }

  trades.sort((a, b) => a.entryTs - b.entryTs);
  return { trades, summary: summarize(trades, qty) };
}

function summarize(trades, qty) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let eq = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    eq += t.pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return {
    qty,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? +((wins.length / trades.length) * 100).toFixed(2) : 0,
    totalPoints: +trades.reduce((s, t) => s + t.points, 0).toFixed(2),
    totalPnl: +total.toFixed(2),
    avgPnl: trades.length ? +(total / trades.length).toFixed(2) : 0,
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null,
    maxDrawdown: +maxDd.toFixed(2),
    longTrades: trades.filter((t) => t.side === 'LONG').length,
    shortTrades: trades.filter((t) => t.side === 'SHORT').length,
  };
}

async function runBacktest({ from, to, symbol = cfg.symbol, csv }) {
  let candles;
  if (csv) {
    candles = JSON.parse(fs.readFileSync(csv, 'utf8'));
  } else {
    candles = await fetchCandles(createClient(), symbol, from, to);
  }
  candles = candles.filter((c) => {
    const m = minuteOfDay(c.ts);
    return m >= cfg.sessionStartMin && m < cfg.sessionEndMin;
  });
  logger.info(`[BT] ${symbol}: ${candles.length} candles`);
  const result = { symbol, from, to, ...simulate(candles) };
  const file = path.join(__dirname, '..', 'output', `backtest_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  logger.info(`[BT] Summary ${JSON.stringify(result.summary)}`);
  logger.info(`[BT] Trade log written to ${file}`);
  return result;
}

module.exports = { simulate, summarize, runBacktest };
