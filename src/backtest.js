const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const logger = require('./logger');
const VwapBandStrategy = require('./strategy');
const { createClient, fetchCandles } = require('./fyers');
const { fmt, dayKey, minuteOfDay } = require('./time');

function simulate(candles, options = {}) {
  const strat = new VwapBandStrategy(options);
  const qty = options.qty ?? cfg.qty;
  const slip = options.slippagePoints ?? cfg.slippagePoints;
  const cost = options.costPerTrade ?? cfg.costPerTrade;
  const trades = [];
  let open = null;

  const exit = (action, price) => {
    const dir = open.side === 'LONG' ? 1 : -1;
    const exitPrice = price - dir * slip;
    const points = (exitPrice - open.entryPrice) * dir;
    trades.push({
      side: open.side,
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
    open = null;
  };

  let prev = null;
  for (const c of candles) {
    // day rolled over with an open position (missing EOD candle): flatten at last known close
    if (open && prev && dayKey(prev.ts) !== dayKey(c.ts)) {
      exit({ type: 'EXIT', reason: 'EOD', ts: prev.ts }, prev.close);
    }

    const a = strat.onOpen({ ts: c.ts, open: c.open });
    if (a?.type === 'ENTER') {
      const dir = a.side === 'LONG' ? 1 : -1;
      const price = a.price + dir * slip;
      strat.applyFill(a, price);
      open = { ...strat.position };
      logger.info(`[BT] ENTRY ${a.side} @ ${price} (${fmt(a.ts)})`);
    } else if (a?.type === 'EXIT') {
      exit(a, a.price);
    }

    const b = strat.onClose(c);
    if (b?.type === 'SETUP') logger.info(`[BT] SETUP ${b.side} ${fmt(b.ts)} open=${b.triggerOpen} close=${b.triggerClose}`);
    else if (b?.type === 'EXIT') exit(b, b.price);

    prev = c;
  }
  if (open && prev) exit({ type: 'EXIT', reason: 'END_OF_DATA', ts: prev.ts }, prev.close);

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
