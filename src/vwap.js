// Daily anchored VWAP on hlc3 with volume-weighted standard deviation bands.
class AnchoredVwap {
  constructor(multiplier = 1) {
    this.multiplier = multiplier;
    this.reset();
  }

  reset() {
    this.sumV = 0;
    this.sumPV = 0;
    this.sumPPV = 0;
    this.lastTp = null;
  }

  update({ high, low, close, volume }) {
    const tp = (high + low + close) / 3;
    this.lastTp = tp;
    // zero-volume candles fall back to a unit weight so the series stays defined
    const v = volume > 0 ? volume : this.sumV === 0 ? 1 : 0;
    this.sumV += v;
    this.sumPV += tp * v;
    this.sumPPV += tp * tp * v;
    return this.bands();
  }

  bands() {
    if (this.sumV === 0) return null;
    const vwap = this.sumPV / this.sumV;
    const variance = Math.max(this.sumPPV / this.sumV - vwap * vwap, 0);
    const sd = Math.sqrt(variance);
    return { vwap, sd, upper: vwap + this.multiplier * sd, lower: vwap - this.multiplier * sd };
  }
}

module.exports = AnchoredVwap;
