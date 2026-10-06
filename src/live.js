const { fyersDataSocket } = require('fyers-api-v3');
const path = require('path');
const cfg = require('./config');
const logger = require('./logger');
const VwapBandStrategy = require('./strategy');
const WeeklyProfitGuard = require('./weekly-profit');
const { createClient, fetchCandles, placeMarketOrder } = require('./fyers');
const { nowIst, minuteStart, minuteOfDay, fmt } = require('./time');

async function runLive() {
  const fyers = createClient();
  const strat = new VwapBandStrategy();
  const weeklyProfit = new WeeklyProfitGuard({
    target: cfg.weeklyProfitTarget,
    filePath: path.join(__dirname, '..', 'output', 'weekly-pnl.json'),
  });
  logger.info(`[LIVE] Starting ${cfg.symbol} qty=${cfg.qty} dryRun=${cfg.dryRun}`);
  logger.info(`[LIVE] Weekly net P&L ${weeklyProfit.netPnl.toFixed(2)} / ${cfg.weeklyProfitTarget.toFixed(2)}; locked=${weeklyProfit.locked}`);

  // Warm up today's VWAP so a mid-day start has correct bands.
  const today = nowIst().toFormat('yyyy-LL-dd');
  try {
    const hist = await fetchCandles(fyers, cfg.symbol, today, today, 1);
    const nowMin = minuteStart(Math.floor(Date.now() / 1000));
    hist.filter((c) => c.ts < nowMin && minuteOfDay(c.ts) >= cfg.sessionStartMin).forEach((c) => strat.seedVwap(c));
    logger.info(`[LIVE] VWAP seeded with ${hist.length} candles`);
  } catch (e) {
    logger.warn(`[LIVE] VWAP warm-up failed: ${e.message}`);
  }

  let candle = null;
  let lastVol = null;
  let lastPrice = null;
  let lastTargetCloseAttempt = 0;
  let busy = Promise.resolve(); // serialises order handling

  async function execute(action, side) {
    const label = `${action.type}${action.reason ? '_' + action.reason : ''}`;
    const price = lastPrice ?? action.price;
    let orderId = 'DRY_RUN';
    try {
      if (!cfg.dryRun) orderId = await placeMarketOrder(fyers, side, label.slice(0, 20));
    } catch (e) {
      logger.error(`[LIVE] ${label} ${side} FAILED: ${e.message}`);
      return false;
    }

    const position = action.type === 'EXIT' ? strat.state[action.side].position : null;
    strat.applyFill(action, price);
    if (position) {
      const direction = position.side === 'LONG' ? 1 : -1;
      const pnl = (price - position.entryPrice) * direction - cfg.costPerTrade / cfg.qty;
      try {
        weeklyProfit.record(pnl, action.ts);
      } catch (e) {
        logger.error(`[LIVE] Weekly P&L state could not be persisted: ${e.message}`);
      }
      logger.info(`[LIVE] Weekly net P&L=${weeklyProfit.netPnl.toFixed(2)} target=${cfg.weeklyProfitTarget.toFixed(2)} locked=${weeklyProfit.locked}`);
    }
    logger.info(`[LIVE] ${label} ${side} filled~${price} orderId=${orderId} (${fmt(action.ts)})`);
    return true;
  }

  async function closeRemainingAtTarget(ts) {
    if (Date.now() - lastTargetCloseAttempt < 5000) return;
    lastTargetCloseAttempt = Date.now();
    for (const side of ['LONG', 'SHORT']) {
      if (!strat.state[side].position) continue;
      await execute({ type: 'EXIT', side, reason: 'WEEKLY_TARGET', ts }, side === 'LONG' ? 'SELL' : 'BUY');
    }
  }

  function estimateOpenPnl(price) {
    return ['LONG', 'SHORT'].reduce((total, side) => {
      const position = strat.state[side].position;
      if (!position) return total;
      const direction = position.side === 'LONG' ? 1 : -1;
      return total + (price - position.entryPrice) * direction - cfg.costPerTrade / cfg.qty;
    }, 0);
  }

  async function checkWeeklyTarget(ts) {
    const unrealizedPnl = estimateOpenPnl(lastPrice);
    const wasLocked = weeklyProfit.locked;
    let locked = weeklyProfit.locked;
    try {
      locked = weeklyProfit.checkTarget(unrealizedPnl, ts);
    } catch (e) {
      logger.error(`[LIVE] Weekly P&L target state could not be saved: ${e.message}`);
      locked = weeklyProfit.locked;
    }
    if (!wasLocked && locked) {
      logger.info(`[LIVE] Weekly profit target reached: estimated net P&L=${(weeklyProfit.netPnl + unrealizedPnl).toFixed(2)}; closing open positions`);
    }
    if (locked && strat.hasPosition()) {
      await closeRemainingAtTarget(ts);
    }
  }

  async function handleAction(a) {
    if (!a) return;
    if (Array.isArray(a)) {
      for (const x of a) await handleAction(x);
      return;
    }
    if (a.type === 'SETUP') {
      if (weeklyProfit.isLocked(a.ts)) {
        strat.resetMemory();
        return;
      }
      logger.info(`[LIVE] SETUP ${a.side} ${fmt(a.ts)} triggerOpen=${a.triggerOpen} triggerClose=${a.triggerClose}`);
    } else if (a.type === 'ENTER') {
      if (weeklyProfit.isLocked(a.ts)) {
        strat.resetMemory();
        return;
      }
      await execute(a, a.side === 'LONG' ? 'BUY' : 'SELL');
    } else if (a.type === 'EXIT') {
      if (!strat.state[a.side].position) return;
      if (a.reason === 'EOD') logger.info(`[LIVE] 15:25 EOD force-close ${a.side}`);
      const filled = await execute(a, a.side === 'LONG' ? 'SELL' : 'BUY');
      if (filled) await checkWeeklyTarget(a.ts);
    }
  }

  // Close the running candle (if its minute is over) and evaluate the new minute's open.
  async function advance(nowSec, price) {
    const ms = minuteStart(nowSec);
    if (candle && candle.ts < ms) {
      const done = candle;
      candle = null;
      if (minuteOfDay(done.ts) >= cfg.sessionStartMin) await handleAction(strat.onClose(done));
    }
    if (!candle) {
      candle = { ts: ms, open: price, high: price, low: price, close: price, volume: 0 };
      if (minuteOfDay(ms) >= cfg.sessionStartMin) await handleAction(strat.onOpen({ ts: ms, open: price }));
    }
  }

  function onTick(msg) {
    if (msg.symbol !== cfg.symbol || typeof msg.ltp !== 'number') return;
    const price = msg.ltp;
    const nowSec = msg.last_traded_time || Math.floor(Date.now() / 1000);
    busy = busy.then(async () => {
      lastPrice = price;
      await checkWeeklyTarget(nowSec);
      await advance(nowSec, price);
      await checkWeeklyTarget(nowSec);
      if (minuteOfDay(candle.ts) < cfg.sessionStartMin) return;
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
      if (typeof msg.vol_traded_today === 'number') {
        if (lastVol !== null && msg.vol_traded_today >= lastVol) candle.volume += msg.vol_traded_today - lastVol;
        lastVol = msg.vol_traded_today;
      }
    });
  }

  const skt = fyersDataSocket.getInstance(`${cfg.appId}:${cfg.accessToken}`, 'logs', false);
  skt.on('connect', () => {
    logger.info('[LIVE] Socket connected');
    skt.subscribe([cfg.symbol]);
    skt.mode(skt.FullMode);
  });
  skt.on('message', onTick);
  skt.on('error', (e) => logger.error(`[LIVE] Socket error: ${JSON.stringify(e)}`));
  skt.on('close', () => logger.warn('[LIVE] Socket closed'));
  skt.autoReconnect(10);
  skt.connect();

  // Wall-clock timer: guarantees minute rollover and the 15:25 IST square-off even without ticks.
  const timer = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (lastPrice !== null) {
      busy = busy.then(async () => {
        await checkWeeklyTarget(nowSec);
        await advance(nowSec, lastPrice);
        await checkWeeklyTarget(nowSec);
      });
    }
    if (minuteOfDay(nowSec) >= cfg.sessionEndMin && !strat.hasPosition()) {
      logger.info('[LIVE] Session over, shutting down');
      clearInterval(timer);
      skt.close();
      process.exit(0);
    }
  }, 1000);
}

module.exports = { runLive };
