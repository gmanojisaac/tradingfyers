const AnchoredVwap = require('./vwap');
const { minuteOfDay, dayKey } = require('./time');
const cfg = require('./config');

const isGreen = (c) => c.close > c.open;
const isRed = (c) => c.close < c.open;
const SIDES = ['LONG', 'SHORT'];

/**
 * Pure state machine shared by backtest and live modes.
 * LONG and SHORT run independently: each side has its own setup and position,
 * so a short can trade while a long is open (and vice versa).
 * Per candle the caller must invoke, in order:
 *   onOpen({ts, open})  -> array of entry / EOD exit actions at the candle open
 *   onClose(candle)     -> array of setup / signal exit actions at the candle close
 * Actions carry their `side`. They are never assumed filled: call applyFill() once the order succeeded.
 * candle: {ts (epoch sec of minute start), open, high, low, close, volume}
 */
class VwapBandStrategy {
  constructor(options = {}) {
    this.cfg = { ...cfg, ...options };
    this.vwap = new AnchoredVwap(this.cfg.bandMultiplier);
    this.day = null;
    // per side: position {side, entryPrice, entryTs, triggerOpen, triggerClose}, pending {side, triggerOpen, triggerClose, ts}
    this.state = { LONG: { position: null, pending: null }, SHORT: { position: null, pending: null } };
  }

  hasPosition() {
    return SIDES.some((s) => this.state[s].position);
  }

  resetMemory() {
    SIDES.forEach((s) => (this.state[s].pending = null));
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
    const actions = [];

    if (m >= this.cfg.eodExitMin) {
      this.resetMemory();
      if (this.cfg.holdOvernight) return actions; // multi-day mode: positions carry over, no EOD square-off
      for (const side of SIDES) {
        if (this.state[side].position) actions.push({ type: 'EXIT', side, reason: 'EOD', ts, price: open });
      }
      return actions;
    }

    if (m < this.cfg.sessionStartMin) return actions;
    if (m > this.cfg.lastEntryMin) {
      this.resetMemory();
      return actions;
    }

    for (const side of SIDES) {
      const { position, pending: p } = this.state[side];
      if (position || !p) continue;
      // the other side's open trade must be at a loss (not in profit) at this open before we add this side
      const other = this.state[side === 'LONG' ? 'SHORT' : 'LONG'].position;
      if (other && (other.side === 'LONG' ? open - other.entryPrice : other.entryPrice - open) > 0) continue;
      if (side === 'LONG' && open >= p.triggerClose) actions.push({ type: 'ENTER', side, ts, price: open });
      if (side === 'SHORT' && open <= p.triggerClose) actions.push({ type: 'ENTER', side, ts, price: open });
    }
    return actions;
  }

  onClose(candle) {
    this._rollDay(candle.ts);
    const bands = this.vwap.update(candle);
    const m = minuteOfDay(candle.ts);
    const actions = [];

    const long = this.state.LONG.position;
    const short = this.state.SHORT.position;
    if (long && isRed(candle) && candle.close < long.triggerOpen) {
      actions.push({ type: 'EXIT', side: 'LONG', reason: 'SIGNAL', ts: candle.ts, price: candle.close, bands });
    }
    if (short && isGreen(candle) && candle.close > short.triggerOpen) {
      actions.push({ type: 'EXIT', side: 'SHORT', reason: 'SIGNAL', ts: candle.ts, price: candle.close, bands });
    }

    if (!bands || m < this.cfg.sessionStartMin || m > this.cfg.lastEntryMin) return actions;

    // candle must open outside the band and close back inside it; a side with an open position takes no new setup
    let side = null;
    if (isGreen(candle) && candle.open < bands.lower && candle.close > bands.lower) side = 'LONG';
    // sell: red candle fully below the lower band (upper band is not used for sells)
    else if (isRed(candle) && candle.open < bands.lower && candle.close < bands.lower) side = 'SHORT';

    if (side && !this.state[side].position) {
      this.state[side].pending = { side, triggerOpen: candle.open, triggerClose: candle.close, ts: candle.ts };
      actions.push({ type: 'SETUP', side, ts: candle.ts, triggerOpen: candle.open, triggerClose: candle.close, bands });
    }
    return actions;
  }

  applyFill(action, price) {
    const st = this.state[action.side];
    if (action.type === 'ENTER') {
      st.position = {
        side: action.side,
        entryPrice: price,
        entryTs: action.ts,
        triggerOpen: st.pending.triggerOpen,
        triggerClose: st.pending.triggerClose,
      };
      st.pending = null;
    } else if (action.type === 'EXIT') {
      st.position = null;
      st.pending = null;
    }
  }
}

module.exports = VwapBandStrategy;
