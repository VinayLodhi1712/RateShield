-- RateShield PostgreSQL Schema — see Database.md Section 5

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL    PRIMARY KEY,
    email         TEXT         NOT NULL UNIQUE,
    password_hash TEXT         NOT NULL,
    role          TEXT         NOT NULL DEFAULT 'developer'
                               CHECK (role IN ('admin', 'developer')),
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          BIGSERIAL    PRIMARY KEY,
    user_id     BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT         NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ  NOT NULL,
    revoked_at  TIMESTAMPTZ  NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
    id           BIGSERIAL    PRIMARY KEY,
    user_id      BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash     TEXT         NOT NULL UNIQUE,
    key_prefix   TEXT         NOT NULL,
    name         TEXT         NOT NULL,
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    last_used_at TIMESTAMPTZ  NULL,
    expires_at   TIMESTAMPTZ  NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(key_hash) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS policies (
    id                   BIGSERIAL    PRIMARY KEY,
    name                 TEXT         NOT NULL,
    description          TEXT         NULL,
    algorithm            TEXT         NOT NULL
                                      CHECK (algorithm IN (
                                          'fixed_window', 'sliding_window',
                                          'sliding_log', 'token_bucket', 'leaky_bucket'
                                      )),
    limit_count          INTEGER      NOT NULL CHECK (limit_count > 0),
    window_seconds       INTEGER      NOT NULL CHECK (window_seconds > 0),
    leak_rate_per_second NUMERIC(10,4) NULL,
    identity_type        TEXT         NOT NULL
                                      CHECK (identity_type IN ('user', 'api_key', 'ip', 'global')),
    user_id              BIGINT       NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_address           INET         NULL,
    endpoint_path        TEXT         NOT NULL DEFAULT '*',
    failure_mode         TEXT         NOT NULL DEFAULT 'open'
                                      CHECK (failure_mode IN ('open', 'closed')),
    is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
    priority             INTEGER      NOT NULL DEFAULT 0,
    created_by           BIGINT       NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policies_lookup
    ON policies(identity_type, user_id, endpoint_path)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_policies_created_at
    ON policies(created_at DESC);
