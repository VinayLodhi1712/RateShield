'use strict';

// Refresh token queries — see Database.md Table 2: refresh_tokens.
const db = require('../config/db');

async function createRefreshToken({ userId, tokenHash, expiresAt }) {
  const res = await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, token_hash, expires_at, revoked_at, created_at;`,
    [userId, tokenHash, expiresAt]
  );
  return res.rows[0];
}

async function findTokenByHash(tokenHash) {
  const res = await db.query(
    `SELECT id, user_id, token_hash, expires_at, revoked_at, created_at
     FROM refresh_tokens
     WHERE token_hash = $1
     LIMIT 1;`,
    [tokenHash]
  );
  return res.rows[0] || null;
}

async function revokeToken(id) {
  const res = await db.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE id = $1
     RETURNING id, user_id, revoked_at;`,
    [id]
  );
  return res.rows[0] || null;
}

module.exports = {
  createRefreshToken,
  findTokenByHash,
  revokeToken,
};
