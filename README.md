# tradingfyers

Intraday VWAP Band Reversion on Nifty futures (FYERS API v3). 1-min candles, daily anchored VWAP (hlc3) with ±1 volume-weighted StdDev bands, all times in IST.

## Setup
    npm install
    copy .env.example .env   # fill FYERS_APP_ID, FYERS_ACCESS_TOKEN, SYMBOL, QTY

The access token is generated through the FYERS login flow (valid for one day); this project does not automate it.

## Run
    npm test
    node index.js backtest --from 2026-09-01 --to 2026-09-30   # JSON trade log -> output/
    node index.js backtest --file candles.json                  # [{ts,open,high,low,close,volume}]
    node index.js live                                          # DRY_RUN=true by default; set DRY_RUN=false for real orders

Logs: `logs/trading.log`.

## Layout
- `src/strategy.js` shared state machine (setups, entry, exits, 15:25 EOD)
- `src/vwap.js` anchored VWAP + bands
- `src/backtest.js`, `src/live.js`, `src/fyers.js`

## Notes
- Entries: candle opens 09:15-15:20 IST. EOD square-off at 15:25 IST (timer-driven in live).
- Live trading stops for the IST week after estimated net P&L (realized plus open-position P&L, less configured costs) reaches `WEEKLY_PROFIT_TARGET` points (default 100, about ₹7,500 at qty 75); open positions are closed and no new trades are opened until Monday. The weekly P&L is persisted in `output/weekly-pnl.json`. Set `WEEKLY_PROFIT_TARGET` to change the limit.
- Live P&L uses observed market prices and configured `COST_PER_TRADE`; it is an estimate because the order API response does not supply the actual fill price here.
- Signal exits fire on candle close; backtest fills at the close, live at the next tick.
- A setup on the same candle that triggers an exit is ignored.
- Expired futures contracts need their specific symbol for backtests; update SYMBOL monthly.
