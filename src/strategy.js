const AnchoredVwap = require('./vwap');
const { minuteOfDay, dayKey } = require('./time');
const cfg = require('./config');

const isGreen = (c) => c.close > c.open;
const isRed = (c) => c.close < c.open;

/**
 * Pure state machine shared by backtest and live modes.
 * Per candle the caller must invoke, in order:
 *   onOpen({ts, open})  -> entry / EOD exit decision at the candle open
 *   onClose(candle)     -> setup detection / signal exit decision at the candle close
 * Actions are returned, never assumed filled: call applyFill() once the order succeeded.
 * candle: {ts (epoch sec of minute start), open, high, low, close, volume}
 */
class VwapBandStrategy {
  constructor(options = {}) {
    this.cfg = { ...cfg, ...options };
    this.vwap = new AnchoredVwap(this.cfg.bandMultiplier);
    this.day = null;
    this.position = null; // {side:'LONG'|'SHORT', entryPrice, entryTs, triggerOpen, triggerClose}
    this.pending = null; // {side, triggerOpen, triggerClose, ts}
  }

  resetMemory() {
    this.pending = null;
  }

  _rollDay(ts) {
    const key = dayKey(ts);
    if (key !== this.day) {
      this.day = key;
      this.vwap.reset();
      this.resetMemory();
    }
  }

  // Feed VWAP only (used to warm up a live session started mid-day). No setups or trades.
  seedVwap(candle) {
    this._rollDay(candle.ts);
    this.vwap.update(candle);
  }

  onOpen({ ts, open }) {
    this._rollDay(ts);
    const m = minuteOfDay(ts);

    if (m >= this.cfg.eodExitMin) {
      this.resetMemory();
      return this.position ? { type: 'EXIT', reason: 'EOD', ts, price: open } : null;
    }
    if (this.position || !this.pending) return null;

    if (m < this.cfg.sessionStartMin || m > this.cfg.lastEntryMin) {
      if (m > this.cfg.lastEntryMin) this.resetMemory();
      return null;
    }

    const p = this.pending;
    if (p.side === 'LONG' && open >= p.triggerClose) return { type: 'ENTER', side: 'LONG', ts, price: open };
    if (p.side === 'SHORT' && open <= p.triggerClose) return { type: 'ENTER', side: 'SHORT', ts, price: open };
    return null;
  }

  onClose(candle) {
    this._rollDay(candle.ts);
    const bands = this.vwap.update(candle);
    const m = minuteOfDay(candle.ts);
    const pos = this.position;

    if (pos) {
      if (pos.side === 'LONG' && isRed(candle) && candle.close < pos.triggerOpen) {
        return { type: 'EXIT', reason: 'SIGNAL', ts: candle.ts, price: candle.close, bands };
      }
      if (pos.side === 'SHORT' && isGreen(candle) && candle.close > pos.triggerOpen) {
        return { type: 'EXIT', reason: 'SIGNAL', ts: candle.ts, price: candle.close, bands };
      }
      return null;
    }

    if (!bands || m < this.cfg.sessionStartMin || m > this.cfg.lastEntryMin) return null;

    let side = null;
    if (isGreen(candle) && candle.low <= bands.lower && candle.high >= bands.lower) side = 'LONG';
    else if (isRed(candle) && candle.low <= bands.upper && candle.high >= bands.upper) side = 'SHORT';

    if (side) {
      // a new setup replaces any older one, so only one setup is ever live (opposing setup cancelled)
      this.pending = { side, triggerOpen: candle.open, triggerClose: candle.close, ts: candle.ts };
      return { type: 'SETUP', side, ts: candle.ts, triggerOpen: candle.open, triggerClose: candle.close, bands };
    }
    return null;
  }

  applyFill(action, price) {
    if (action.type === 'ENTER') {
      this.position = {
        side: action.side,
        entryPrice: price,
        entryTs: action.ts,
        triggerOpen: this.pending.triggerOpen,
        triggerClose: this.pending.triggerClose,
      };
      this.pending = null;
    } else if (action.type === 'EXIT') {
      this.position = null;
      this.resetMemory();
    }
  }
}

module.exports = VwapBandStrategy;
