'use strict';

// server.js — entry point. Only responsibility: load env, validate config, start listening.
// Separated from app.js so tests can import the app without binding a port.

require('dotenv').config();

const config = require('./config'); // throws immediately if any required env var is missing
const logger = require('./utils/logger'); // must come after config loads
const app    = require('./app');

const server = app.listen(config.server.port, () => {
  logger.info(`Server running on port ${config.server.port} (${config.server.env})`);
  logger.info(`Health: http://localhost:${config.server.port}/health`);
});

// Graceful shutdown — finish in-flight requests before exit.
// Milestone 8: add Redis + PG pool.close() here.
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = server;
