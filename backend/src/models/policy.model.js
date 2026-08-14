'use strict';

// Policy database queries — see Database.md Section 5 and Section 7.
const db = require('../config/db');

async function findMatchingPolicy({ userId = null, ipAddress = '127.0.0.1', endpointPath = '*' }) {
  const query = `
    SELECT id, name, algorithm, limit_count, window_seconds, leak_rate_per_second,
           identity_type, user_id, ip_address, endpoint_path, failure_mode, is_active, priority
    FROM policies
    WHERE is_active = TRUE
      AND (
        (identity_type = 'user' AND user_id = $1)
        OR (identity_type = 'ip' AND (ip_address = $2 OR ip_address = '0.0.0.0/0'))
        OR (identity_type = 'global')
      )
      AND (endpoint_path = $3 OR endpoint_path = '*')
    ORDER BY
      (endpoint_path != '*') DESC,
      (identity_type != 'global') DESC,
      priority DESC
    LIMIT 1;
  `;

  const res = await db.query(query, [userId, ipAddress, endpointPath]);
  return res.rows[0] || null;
}

async function createPolicy(data) {
  const query = `
    INSERT INTO policies (
      name, description, algorithm, limit_count, window_seconds,
      leak_rate_per_second, identity_type, user_id, ip_address,
      endpoint_path, failure_mode, is_active, priority, created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *;
  `;

  const values = [
    data.name,
    data.description || null,
    data.algorithm || 'fixed_window',
    data.limit_count,
    data.window_seconds,
    data.leak_rate_per_second || null,
    data.identity_type || 'global',
    data.user_id || null,
    data.ip_address || null,
    data.endpoint_path || '*',
    data.failure_mode || 'open',
    data.is_active !== undefined ? data.is_active : true,
    data.priority || 0,
    data.created_by || null,
  ];

  const res = await db.query(query, values);
  return res.rows[0];
}

async function getAllPolicies() {
  const res = await db.query('SELECT * FROM policies ORDER BY priority DESC, created_at DESC;');
  return res.rows;
}

module.exports = {
  findMatchingPolicy,
  createPolicy,
  getAllPolicies,
};
