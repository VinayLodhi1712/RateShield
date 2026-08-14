'use strict';

// Database schema initialization & seed script — see Database.md Section 8.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { pool } = require('../config/db');
const logger = require('../utils/logger');

async function initAndSeed() {
  const client = await pool.connect();
  try {
    logger.info('[DB] Running schema DDL...');
    const ddl = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await client.query(ddl);
    logger.info('[DB] Schema DDL applied successfully');

    // 1. Seed Default Admin User
    const adminEmail = 'admin@rateshield.io';
    const existingAdmin = await client.query('SELECT id FROM users WHERE email = $1;', [adminEmail]);

    if (existingAdmin.rows.length === 0) {
      const passwordHash = await bcrypt.hash('AdminSecure2026!', 10);
      await client.query(
        `INSERT INTO users (email, password_hash, role, is_active)
         VALUES ($1, $2, 'admin', TRUE);`,
        [adminEmail, passwordHash]
      );
      logger.info(`[DB] Seeded default admin user: ${adminEmail}`);
    }

    // 2. Seed Default Global Rate Limit Policy
    const existingGlobal = await client.query(
      "SELECT id FROM policies WHERE identity_type = 'global' AND endpoint_path = '*';"
    );
    if (existingGlobal.rows.length === 0) {
      await client.query(
        `INSERT INTO policies (name, description, algorithm, limit_count, window_seconds, identity_type, endpoint_path, failure_mode, priority, is_active)
         VALUES ('Default Global Policy', 'Catch-all rate limit for general traffic', 'fixed_window', 100, 60, 'global', '*', 'open', 0, TRUE);`
      );
      logger.info('[DB] Seeded Default Global Policy (100 req/60s)');
    }

    // 3. Seed Strict Login Endpoint Policy (Fail-Closed)
    const existingLoginPolicy = await client.query(
      "SELECT id FROM policies WHERE endpoint_path = 'POST /auth/login';"
    );
    if (existingLoginPolicy.rows.length === 0) {
      await client.query(
        `INSERT INTO policies (name, description, algorithm, limit_count, window_seconds, identity_type, ip_address, endpoint_path, failure_mode, priority, is_active)
         VALUES ('Strict Login Policy', 'Brute-force protection on login endpoint', 'fixed_window', 5, 60, 'ip', '0.0.0.0/0', 'POST /auth/login', 'closed', 10, TRUE);`
      );
      logger.info('[DB] Seeded Strict Login Policy (5 req/60s, fail-closed)');
    }

    logger.info('[DB] Database seeding completed successfully.');
  } catch (err) {
    logger.error(`[DB] Seeding failed: ${err.message}`);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  initAndSeed()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { initAndSeed };
