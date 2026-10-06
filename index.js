const logger = require('./src/logger');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

(async () => {
  const mode = process.argv[2];
  if (mode === 'backtest') {
    const from = arg('from');
    const to = arg('to');
    const csv = arg('file');
    if (!csv && (!from || !to)) {
      throw new Error('Usage: node index.js backtest --from YYYY-MM-DD --to YYYY-MM-DD [--symbol NSE:...] | --file candles.json');
    }
    await require('./src/backtest').runBacktest({ from, to, csv, symbol: arg('symbol') || undefined });
  } else if (mode === 'live') {
    await require('./src/live').runLive();
  } else {
    console.log('Usage:\n  node index.js backtest --from 2026-09-01 --to 2026-09-30\n  node index.js live');
  }
})().catch((e) => {
  logger.error(e.stack || e.message);
  process.exit(1);
});
