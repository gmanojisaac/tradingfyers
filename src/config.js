require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  zone: 'Asia/Kolkata',
  symbol: process.env.SYMBOL || 'NSE:NIFTY26OCTFUT', // update to the active monthly contract
  qty: num(process.env.QTY, 75), // must be a multiple of the Nifty lot size - verify current lot size
  productType: process.env.PRODUCT_TYPE || 'INTRADAY',
  appId: process.env.FYERS_APP_ID,
  accessToken: process.env.FYERS_ACCESS_TOKEN,
  dryRun: String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
  slippagePoints: num(process.env.SLIPPAGE_POINTS, 0),
  costPerTrade: num(process.env.COST_PER_TRADE, 0), // flat INR per round trip
  // minutes since midnight IST
  sessionStartMin: 9 * 60 + 15,
  lastEntryMin: 15 * 60 + 20,
  eodExitMin: 15 * 60 + 25,
  sessionEndMin: 15 * 60 + 30,
  bandMultiplier: 1,
};
