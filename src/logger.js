const path = require('path');
const winston = require('winston');
const { DateTime } = require('luxon');
const { zone } = require('./config');

const istStamp = winston.format((info) => {
  info.timestamp = DateTime.now().setZone(zone).toFormat('yyyy-LL-dd HH:mm:ss');
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    istStamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} IST [${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: path.join(__dirname, '..', 'logs', 'trading.log') }),
    new winston.transports.Console(),
  ],
});

module.exports = logger;
