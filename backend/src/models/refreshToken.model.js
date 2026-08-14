'use strict';

// Refresh token queries — see Database.md Table 2: refresh_tokens.
const db = require('../config/db');
const logger = require('../utils/logger');

// In-memory fallback store for standalone development mode
const inMemoryTokens = new Map();
let nextTokenId = 1;

async function createRefreshToken({ userId, tokenHash, expiresAt }) {
  try {
    const res = await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, expires_at, revoked_at, created_at;`,
      [userId, tokenHash, expiresAt]
    );
    return res.rows[0];
  } catch (err) {
    logger.warn(`[Token] DB write fallback to in-memory: ${err.message}`);
    const record = {
      id: nextTokenId++,
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      revoked_at: null,
      created_at: new Date().toISOString(),
    };
    inMemoryTokens.set(tokenHash, record);
    return record;
  }
}

async function findTokenByHash(tokenHash) {
  try {
    const res = await db.query(
      `SELECT id, user_id, token_hash, expires_at, revoked_at, created_at
       FROM refresh_tokens
       WHERE token_hash = $1
       LIMIT 1;`,
      [tokenHash]
    );
    return res.rows[0] || null;
  } catch (err) {
    return inMemoryTokens.get(tokenHash) || null;
  }
}

async function revokeToken(id) {
  try {
    const res = await db.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW()
       WHERE id = $1
       RETURNING id, user_id, revoked_at;`,
      [id]
    );
    return res.rows[0] || null;
  } catch (err) {
    for (const t of inMemoryTokens.values()) {
      if (t.id === Number(id)) {
        t.revoked_at = new Date().toISOString();
        return t;
      }
    }
    return null;
  }
}

module.exports = {
  createRefreshToken,
  findTokenByHash,
  revokeToken,
};
