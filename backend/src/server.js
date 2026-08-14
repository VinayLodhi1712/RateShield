'use strict';

// Server entry point — loads env, validates config, starts listening.
require('dotenv').config();

const config = require('./config');
const logger = require('./utils/logger');
const { closeRedis } = require('./config/redis');
const { closeDb } = require('./config/db');
const app = require('./app');

const server = app.listen(config.server.port, () => {
  logger.info(`Server running on port ${config.server.port} (${config.server.env})`);
  logger.info(`Health: http://localhost:${config.server.port}/health`);
});

// Graceful shutdown — drains in-flight HTTP requests, closes Redis and PG pools cleanly.
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully...`);
  server.close(async () => {
    logger.info('HTTP server closed.');
    await closeRedis();
    await closeDb();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = server;
