'use strict';

// Winston logger — single shared instance imported by all modules.
// Dev: colorized human-readable. Prod: JSON for log aggregators.
// Log level controlled by config.logging.level (validated at startup).

const { createLogger, format, transports } = require('winston');
const config = require('../config');

const devFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

const prodFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }), // include stack traces in prod JSON logs
  format.json()
);

const logger = createLogger({
  level: config.logging.level,
  format: config.server.isDev ? devFormat : prodFormat,
  transports: [new transports.Console()],
});

module.exports = logger;
