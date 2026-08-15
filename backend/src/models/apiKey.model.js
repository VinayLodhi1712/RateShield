'use strict';

// API Key model queries — see Database.md Table 3: api_keys.
const db = require('../config/db');
const logger = require('../utils/logger');

// In-memory fallback store for standalone development mode
const inMemoryApiKeys = new Map();
let nextApiKeyId = 1;

async function createApiKey({ userId, keyHash, keyPrefix, name, expiresAt = null }) {
  try {
    const res = await db.query(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, expires_at, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, user_id, key_prefix, name, is_active, expires_at, created_at;`,
      [userId, keyHash, keyPrefix, name, expiresAt]
    );
    return res.rows[0];
  } catch (err) {
    logger.warn(`[ApiKey] DB write fallback to in-memory: ${err.message}`);
    const record = {
      id: nextApiKeyId++,
      user_id: userId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name,
      is_active: true,
      last_used_at: null,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    };
    inMemoryApiKeys.set(keyHash, record);
    return record;
  }
}

async function findByKeyHash(keyHash) {
  try {
    const res = await db.query(
      `SELECT k.id, k.user_id, k.key_hash, k.key_prefix, k.name, k.is_active, k.expires_at, k.last_used_at,
              u.email AS user_email, u.role AS user_role, u.is_active AS user_active
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = $1
       LIMIT 1;`,
      [keyHash]
    );
    return res.rows[0] || null;
  } catch (err) {
    const record = inMemoryApiKeys.get(keyHash);
    if (!record) return null;
    return {
      ...record,
      user_email: 'developer@rateshield.io',
      user_role: 'developer',
      user_active: true,
    };
  }
}

async function findByUserId(userId, { includeInactive = false, limit = 20 } = {}) {
  try {
    const query = includeInactive
      ? `SELECT id, name, key_prefix AS prefix, is_active AS "isActive", last_used_at AS "lastUsedAt",
                expires_at AS "expiresAt", created_at AS "createdAt"
         FROM api_keys
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2;`
      : `SELECT id, name, key_prefix AS prefix, is_active AS "isActive", last_used_at AS "lastUsedAt",
                expires_at AS "expiresAt", created_at AS "createdAt"
         FROM api_keys
         WHERE user_id = $1 AND is_active = TRUE
         ORDER BY created_at DESC
         LIMIT $2;`;

    const res = await db.query(query, [userId, limit]);
    return res.rows;
  } catch (err) {
    const list = [];
    for (const record of inMemoryApiKeys.values()) {
      if (record.user_id === Number(userId)) {
        if (includeInactive || record.is_active) {
          list.push({
            id: record.id,
            name: record.name,
            prefix: record.key_prefix,
            isActive: record.is_active,
            lastUsedAt: record.last_used_at,
            expiresAt: record.expires_at,
            createdAt: record.created_at,
          });
        }
      }
    }
    return list.slice(0, limit);
  }
}

async function revokeKey(id, userId) {
  try {
    const res = await db.query(
      `UPDATE api_keys
       SET is_active = FALSE
       WHERE id = $1 AND user_id = $2
       RETURNING id, key_prefix, name, is_active;`,
      [id, userId]
    );
    return res.rows[0] || null;
  } catch (err) {
    for (const record of inMemoryApiKeys.values()) {
      if (record.id === Number(id) && record.user_id === Number(userId)) {
        record.is_active = false;
        return record;
      }
    }
    return null;
  }
}

async function touchLastUsed(id) {
  try {
    await db.query(
      'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1;',
      [id]
    );
  } catch {
    // Fire-and-forget best effort — see Database.md Table 3 note
  }
}

module.exports = {
  createApiKey,
  findByKeyHash,
  findByUserId,
  revokeKey,
  touchLastUsed,
  inMemoryApiKeys,
};
