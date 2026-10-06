const { fyersDataSocket } = require('fyers-api-v3');
const cfg = require('./config');
const logger = require('./logger');
const VwapBandStrategy = require('./strategy');
const { createClient, fetchCandles, placeMarketOrder } = require('./fyers');
const { nowIst, minuteStart, minuteOfDay, fmt } = require('./time');

async function runLive() {
  const fyers = createClient();
  const strat = new VwapBandStrategy();
  logger.info(`[LIVE] Starting ${cfg.symbol} qty=${cfg.qty} dryRun=${cfg.dryRun}`);

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
  let busy = Promise.resolve(); // serialises order handling

  async function execute(action, side) {
    const label = `${action.type}${action.reason ? '_' + action.reason : ''}`;
    try {
      let orderId = 'DRY_RUN';
      if (!cfg.dryRun) orderId = await placeMarketOrder(fyers, side, label.slice(0, 20));
      const price = action.price ?? lastPrice;
      strat.applyFill(action, price);
      logger.info(`[LIVE] ${label} ${side} filled~${price} orderId=${orderId} (${fmt(action.ts)})`);
    } catch (e) {
      logger.error(`[LIVE] ${label} ${side} FAILED: ${e.message}`);
    }
  }

  async function handleAction(a) {
    if (!a) return;
    if (a.type === 'SETUP') {
      logger.info(`[LIVE] SETUP ${a.side} ${fmt(a.ts)} triggerOpen=${a.triggerOpen} triggerClose=${a.triggerClose}`);
    } else if (a.type === 'ENTER') {
      await execute(a, a.side === 'LONG' ? 'BUY' : 'SELL');
    } else if (a.type === 'EXIT') {
      if (a.reason === 'EOD') logger.info('[LIVE] 15:25 EOD force-close');
      await execute(a, strat.position?.side === 'LONG' ? 'SELL' : 'BUY');
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
      await advance(nowSec, price);
      if (minuteOfDay(candle.ts) < cfg.sessionStartMin) return;
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
      if (typeof msg.vol_traded_today === 'number') {
        if (lastVol !== null && msg.vol_traded_today >= lastVol) candle.volume += msg.vol_traded_today - lastVol;
        lastVol = msg.vol_traded_today;
      }
      lastPrice = price;
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
    if (lastPrice !== null) busy = busy.then(() => advance(nowSec, lastPrice));
    if (minuteOfDay(nowSec) >= cfg.sessionEndMin && !strat.position) {
      logger.info('[LIVE] Session over, shutting down');
      clearInterval(timer);
      skt.close();
      process.exit(0);
    }
  }, 1000);
}

module.exports = { runLive };
