const fs = require('fs');
const path = require('path');
const { weekKey } = require('./time');

class WeeklyProfitGuard {
  constructor({ target = 100, filePath, initialTs = Math.floor(Date.now() / 1000) } = {}) {
    if (!Number.isFinite(target) || target < 0) {
      throw new RangeError('Weekly profit target must be a non-negative finite number');
    }
    this.target = target;
    this.filePath = filePath;
    this.week = weekKey(initialTs);
    this.netPnl = 0;
    this.locked = false;

    if (filePath) this._load();
  }

  isLocked(ts) {
    this._rollWeek(ts);
    return this.locked;
  }

  checkTarget(unrealizedPnl = 0, ts) {
    this._rollWeek(ts);
    if (!Number.isFinite(unrealizedPnl)) {
      throw new RangeError('Unrealized weekly P&L must be a finite number');
    }
    if (!this.locked && +(this.netPnl + unrealizedPnl).toFixed(2) >= this.target) {
      this.locked = true;
      this._save();
    }
    return this.locked;
  }

  record(pnl, ts) {
    this._rollWeek(ts);
    if (!Number.isFinite(pnl)) throw new RangeError('Weekly P&L must be a finite number');
    this.netPnl = +(this.netPnl + pnl).toFixed(2);
    if (this.netPnl >= this.target) this.locked = true;
    this._save();
    return this.locked;
  }

  _rollWeek(ts) {
    const currentWeek = weekKey(ts);
    if (currentWeek === this.week) return;
    this.week = currentWeek;
    this.netPnl = 0;
    this.locked = false;
    this._save();
  }

  _load() {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    if (
      typeof state.week !== 'string'
      || !Number.isFinite(state.netPnl)
      || typeof state.locked !== 'boolean'
    ) {
      throw new Error(`Invalid weekly profit state in ${this.filePath}`);
    }

    if (state.week === this.week) {
      this.netPnl = state.netPnl;
      this.locked = state.locked;
    }
  }

  _save() {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({
      week: this.week,
      netPnl: this.netPnl,
      locked: this.locked,
    }, null, 2));
  }
}

module.exports = WeeklyProfitGuard;
