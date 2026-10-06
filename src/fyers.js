const { fyersModel } = require('fyers-api-v3');
const { DateTime } = require('luxon');
const cfg = require('./config');
const logger = require('./logger');

function requireAuth() {
  if (!cfg.appId || !cfg.accessToken) {
    throw new Error('Set FYERS_APP_ID and FYERS_ACCESS_TOKEN in .env');
  }
}

function createClient() {
  requireAuth();
  const fyers = new fyersModel({ path: 'logs', enableLogging: false });
  fyers.setAppId(cfg.appId);
  fyers.setAccessToken(cfg.accessToken);
  return fyers;
}

// History API caps 1-minute data at ~100 days per request, so fetch in chunks.
async function fetchCandles(fyers, symbol, fromDate, toDate, chunkDays = 90) {
  const out = new Map();
  let start = DateTime.fromISO(fromDate, { zone: cfg.zone });
  const end = DateTime.fromISO(toDate, { zone: cfg.zone });
  while (start <= end) {
    const stop = DateTime.min(start.plus({ days: chunkDays - 1 }), end);
    const res = await fyers.getHistory({
      symbol,
      resolution: '1',
      date_format: '1',
      range_from: start.toFormat('yyyy-LL-dd'),
      range_to: stop.toFormat('yyyy-LL-dd'),
      cont_flag: '1',
    });
    if (res.s !== 'ok' && res.s !== 'no_data') {
      throw new Error(`History error: ${JSON.stringify(res)}`);
    }
    for (const [ts, open, high, low, close, volume] of res.candles || []) {
      out.set(ts, { ts, open, high, low, close, volume });
    }
    logger.info(`Fetched ${res.candles?.length || 0} candles ${start.toISODate()} -> ${stop.toISODate()}`);
    start = stop.plus({ days: 1 });
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

async function placeMarketOrder(fyers, side, tag) {
  const order = {
    symbol: cfg.symbol,
    qty: cfg.qty,
    type: 2, // market
    side: side === 'BUY' ? 1 : -1,
    productType: cfg.productType,
    limitPrice: 0,
    stopPrice: 0,
    validity: 'DAY',
    disclosedQty: 0,
    offlineOrder: false,
    orderTag: tag,
  };
  const res = await fyers.place_order(order);
  if (res.s !== 'ok') throw new Error(`Order rejected: ${JSON.stringify(res)}`);
  return res.id;
}

module.exports = { createClient, fetchCandles, placeMarketOrder, requireAuth };
