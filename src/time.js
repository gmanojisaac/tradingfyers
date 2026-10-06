const { DateTime } = require('luxon');
const { zone } = require('./config');

const toIst = (epochSec) => DateTime.fromSeconds(epochSec, { zone });
const nowIst = () => DateTime.now().setZone(zone);
const minuteOfDay = (epochSec) => {
  const d = toIst(epochSec);
  return d.hour * 60 + d.minute;
};
const dayKey = (epochSec) => toIst(epochSec).toFormat('yyyy-LL-dd');
const weekKey = (epochSec) => toIst(epochSec).startOf('week').toFormat('yyyy-LL-dd');
const fmt = (epochSec) => toIst(epochSec).toFormat('yyyy-LL-dd HH:mm:ss');
const minuteStart = (epochSec) => Math.floor(epochSec / 60) * 60;

module.exports = { toIst, nowIst, minuteOfDay, dayKey, weekKey, fmt, minuteStart };
