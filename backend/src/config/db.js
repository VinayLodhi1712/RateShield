'use strict';

// PostgreSQL connection pool wrapper — see Architecture.md Section 2.5.
const { Pool } = require('pg');
const config = require('./index');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: config.db.url,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error(`[PostgreSQL] Unexpected pool error: ${err.message}`);
});

async function pingDb() {
  const start = Date.now();
  try {
    await pool.query('SELECT 1;');
    return { status: 'healthy', latencyMs: Date.now() - start, error: null };
  } catch (err) {
    return { status: 'unhealthy', latencyMs: null, error: err.message };
  }
}

async function closeDb() {
  try {
    await pool.end();
  } catch (err) {
    logger.warn(`[PostgreSQL] Error during pool shutdown: ${err.message}`);
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  pingDb,
  closeDb,
};
