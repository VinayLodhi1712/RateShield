# Database Design — RateShield

**Version:** 1.0  
**Date:** 2026-07-30  
**Author:** Vinay Anand Lodhi  
**Status:** Draft — pending review

---

## Table of Contents

1. [What This Document Covers](#1-what-this-document-covers)
2. [PostgreSQL Fundamentals (for First-Timers)](#2-postgresql-fundamentals-for-first-timers)
3. [Why PostgreSQL (and Not Redis or MongoDB)](#3-why-postgresql-and-not-redis-or-mongodb)
4. [Resolving Redis.md Open Questions](#4-resolving-redismd-open-questions)
5. [Full Schema](#5-full-schema)
6. [Indexing Strategy](#6-indexing-strategy)
7. [How Policy Lookups Work End-to-End](#7-how-policy-lookups-work-end-to-end)
8. [Migration Strategy](#8-migration-strategy)
9. [Entity Relationship Diagram](#9-entity-relationship-diagram)

---

## 1. What This Document Covers

`Architecture.md` explained *which* data lives in PostgreSQL and *why*. `Redis.md` explained *which* data lives in Redis and *why*. This document covers the PostgreSQL side at schema depth — the actual columns, types, constraints, indexes, and the reasoning behind every design choice.

After reading this document you should be able to answer:

- What are the tables, and what does every column do?
- Which column types were chosen and why?
- Why do certain columns have indexes, and what exactly does an index do?
- How does a policy lookup in Node.js translate to a SQL query?
- How does the schema change over time as the project evolves?

This document intentionally avoids Node.js ORM code. Schema is shown as SQL DDL (Data Definition Language) for clarity. The actual implementation uses a migration tool — see [Section 8](#8-migration-strategy).

---

## 2. PostgreSQL Fundamentals (for First-Timers)

> **Skip this section if you are already comfortable with relational databases.** It is here because the PRD names learning as a primary goal.

### What is a relational database?

A relational database organises data into **tables** (like spreadsheets), where:
- Each table has **columns** (fields with a fixed type: integer, text, timestamp, etc.)
- Each table has **rows** (individual records)
- Tables are connected to each other via **foreign keys** — a column in one table that references the primary key of another

For example, an `api_keys` row knows which user it belongs to because it has a `user_id` column that points to a row in the `users` table. This link is the "relational" part.

### What is a primary key?

Every table has a **primary key** — a column (or combination of columns) whose value uniquely identifies each row. No two rows can have the same primary key. RateShield uses `BIGSERIAL` for most primary keys, which is an auto-incrementing 64-bit integer that PostgreSQL manages automatically.

### What is a foreign key?

A **foreign key** is a column that references the primary key of another table. PostgreSQL enforces this constraint: you cannot insert a row with a `user_id` that does not exist in the `users` table. This prevents orphaned data.

### What is a constraint?

A **constraint** is a rule that PostgreSQL enforces on every insert and update. Examples:
- `NOT NULL` — the column must always have a value
- `UNIQUE` — no two rows can have the same value in this column
- `CHECK (condition)` — the value must satisfy a boolean expression (e.g., `CHECK (limit_count > 0)`)
- `DEFAULT value` — if you don't provide a value, use this one

### What is an index?

An **index** is a separate data structure PostgreSQL maintains alongside a table to make certain queries fast. Without an index, finding a row means scanning every single row in the table (a "full table scan"). With an index on the right column, PostgreSQL can jump directly to the matching rows in O(log N) time.

The trade-off: indexes speed up reads but slow down writes (every insert/update must also update the index). You create indexes on columns you query or filter on frequently.

---

## 3. Why PostgreSQL (and Not Redis or MongoDB)

`Architecture.md Section 5` already covered the Redis vs PostgreSQL split. This section addresses why PostgreSQL specifically (rather than MongoDB or another SQL database) for the durable data layer.

### Why not MongoDB?

MongoDB is a document store — it stores JSON-like objects without a fixed schema. It is excellent for:
- Rapidly evolving schemas where you don't know all fields upfront
- Deeply nested documents that don't fit neatly into tables
- Teams building fast prototypes

RateShield's data does **not** fit this profile:
- The schema is well-understood and stable — users, api_keys, policies, audit_logs
- The data is highly relational: a policy belongs to a user, an API key belongs to a user, an audit log entry references a policy and a user
- Admin analytics require `GROUP BY`, aggregations, and joins — things MongoDB can do but SQL does far more cleanly
- ACID transactions matter: when creating a user and their first policy together, either both succeed or neither does

MongoDB would work, but PostgreSQL is a better fit. More importantly, PostgreSQL is what you will use at most companies, so learning it here is a more transferable skill.

### Why not a different SQL database (MySQL, SQLite)?

| Database | Why Not Chosen |
|---|---|
| **SQLite** | File-based, single-writer at a time. Perfect for mobile apps or embedded systems. Not suitable for a server application with concurrent writes from multiple connections. |
| **MySQL** | Perfectly viable. PostgreSQL is chosen because it has better support for `RETURNING` clauses, richer constraint syntax, and `BIGSERIAL` — all used in this schema. PostgreSQL is also more commonly seen in new backend projects today. |
| **CockroachDB / Planetscale** | Distributed SQL databases. Solve a problem (multi-region distribution) that is explicitly out of scope for v1. |

---

## 4. Resolving Redis.md Open Questions

`Redis.md Section 8` left six open questions. Each one is resolved here, because the answers determine which columns the `policies` table needs.

---

### Q1 — Default Window Size for Fixed Window

**Question:** What is the default window size for Fixed Window if a policy does not specify one?

**Decision: 60 seconds. Stored as a code constant, not a DB column.**

**Reasoning:** Every policy row already has a `window_seconds` column (see Section 5). The `policies` table always requires a `window_seconds` value — it is `NOT NULL`. The "default" only matters at the application layer when creating a new policy via the API if the caller omits the field. The API handler will substitute `60` before writing to the database.

This means: there is no ambiguity in the database — every policy row has an explicit window size. The default is an application-layer concern documented in `docs/API.md`.

---

### Q2 — Token Bucket Refill Rate

**Question:** What is the default token refill rate for Token Bucket if not specified in a policy?

**Decision: Derived as `limit_count / window_seconds`. No new column.**

**Reasoning:** A Token Bucket policy that says "100 requests per 60 seconds" maps naturally to a refill rate of 100/60 ≈ 1.667 tokens per second. This derivation is correct for the common case: a user who consumes tokens steadily will be allowed exactly `limit_count` requests per `window_seconds` period.

A separate `refill_rate` column would only be needed if the operator wanted a *different* refill rate than what the limit implies — for example, allow 100 tokens per minute but only refill at 0.5/sec (meaning bursts are possible but recovery is slow). For v1, this edge case is not required by the PRD. The formula is a code constant derivable from existing columns.

**If this is revisited in v2:** Add `refill_rate_per_second NUMERIC(10,4) NULL` to the `policies` table. When `NULL`, the application derives the rate; when set, it overrides the formula.

---

### Q3 — Failure Mode: Global env var vs. Per-Policy Column

**Question:** Should `RATE_LIMIT_FAILURE_MODE` be a global environment variable or a per-policy column?

**This is the most important schema decision in this document. Here are both sides.**

**Argument for global env var:**
- Simpler. One setting, one place. No schema change.
- Fail-open is safe for most endpoints. A temporary Redis outage is rare.
- Operators who need fail-closed can set the env var globally.
- Avoids schema complexity for a v1 project focused on learning.

**Argument for per-policy column:**
- The user explicitly raised the login/auth endpoint security gap. The concern is real: if Redis goes down and `POST /auth/login` or `POST /auth/register` fail-open, a brute-force attacker can attempt unlimited password guesses during that outage window. A global fail-open setting means you cannot protect this endpoint differently.
- Adding the column later requires a migration, a model change, and an API change. Adding it now is one extra `TEXT` column with a `CHECK` constraint.
- The column costs essentially nothing in storage (~4 bytes per policy row).
- It is more educational: you learn about `CHECK` constraints, application-layer defaults, and the `COALESCE` pattern.
- Real production rate limiters (Kong, AWS API Gateway WAF) universally offer per-endpoint configuration.

**Decision: Add a `failure_mode` column to the `policies` table.**

```sql
failure_mode TEXT NOT NULL DEFAULT 'open' CHECK (failure_mode IN ('open', 'closed'))
```

The global `RATE_LIMIT_FAILURE_MODE` environment variable still exists as the system-wide fallback for cases where you want to override everything at once (e.g., set it to `closed` during a known attack). The per-policy column takes precedence when it is explicitly set. Application logic: `effectiveMode = policy.failure_mode ?? process.env.RATE_LIMIT_FAILURE_MODE ?? 'open'`.

This is one of the few cases where adding the column now is clearly the right call — the security argument is sound, and the cost is negligible.

---

### Q4 — Sliding Log Grace TTL

**Question:** What is the grace TTL added beyond the window size for Sliding Log?

**Decision: 2× the window size. Derived from `window_seconds`. No DB column.**

**Reasoning:** A Sliding Log key should not expire while requests might still need to reference it. The window size is already in the `policies` table. The grace TTL is: `window_seconds + (2 * window_seconds) = 3 * window_seconds`. This formula is a code constant in the Sliding Log Redis module. No schema change is needed.

---

### Q5 — Token Bucket / Leaky Bucket Idle TTL

**Question:** What is the idle TTL before a Token/Leaky Bucket key is deleted from Redis?

**Decision: 24 hours. Code constant. No DB column.**

**Reasoning:** 24 hours balances memory efficiency against user experience. A user who was active yesterday and returns today within 24 hours keeps their bucket state. A user who has been dormant for more than 24 hours gets a fresh full bucket on their next request — which is the correct and generous behaviour for a rate limiter.

If you wanted this configurable per-policy, you would add an `idle_ttl_seconds INTEGER NOT NULL DEFAULT 86400` column. For v1, that is unnecessary complexity — 24 hours is a reasonable universal constant.

---

### Q6 — Leaky Bucket Leak Rate

**Question:** For Leaky Bucket, is the leak rate configurable per policy, or derived from limit/window?

**Decision: Configurable per policy. Add `leak_rate_per_second NUMERIC(10,4) NULL`.**

**Reasoning:** This is the one case where the derivation `limit / window_seconds` is semantically wrong for Leaky Bucket. Unlike Token Bucket (which models *consumption rate*), Leaky Bucket models *processing rate* — how fast the queue drains, independent of how many items are allowed to wait. The capacity (queue size) and the leak rate are two separate concepts.

For example:
- Queue capacity: 20 items (set via `limit_count`)
- Leak rate: 5 requests per second (how fast the queue drains)

If leak rate were derived as `limit / window`, a policy of "20 requests per 60 seconds" would give 0.33 req/sec — which may not be what the operator wants. Providing an explicit column makes the algorithm properly distinct from Token Bucket.

When `leak_rate_per_second` is `NULL` for a Leaky Bucket policy, the application falls back to `limit_count / window_seconds` as a safe default. When it is set, that value is used directly.

---

## 5. Full Schema

### Overview of Tables

| Table | Purpose | Primary Relationship |
|---|---|---|
| `users` | Authentication — who can log in, their role | None (root entity) |
| `refresh_tokens` | JWT refresh token store — enables logout and token rotation | Belongs to `users` |
| `api_keys` | API key credentials tied to a user | Belongs to `users` |
| `policies` | Rate limit rules — algorithm, limit, window, per identity/endpoint | Belongs to `users` (optional) |
| `audit_logs` | Record of every rate-limit event (allowed and blocked) | References `policies` and stores `user_id` |

---

### Table 1: `users`

This table is the root of the system. Every other table (except IP-based policies) ultimately relates back to a user.

#### Column Definitions

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing unique identifier. 64-bit integer — supports ~9.2 quintillion rows, effectively infinite. |
| `email` | `TEXT` | `NOT NULL, UNIQUE` | Login identifier. `UNIQUE` prevents duplicate registrations. `TEXT` instead of `VARCHAR(255)` — in PostgreSQL, `TEXT` is identical in performance and has no arbitrary length limit. |
| `password_hash` | `TEXT` | `NOT NULL` | bcrypt hash of the user's password. **Never store plaintext passwords.** bcrypt output is always ~60 characters but `TEXT` leaves room for algorithm migration (e.g., Argon2 in the future). |
| `role` | `TEXT` | `NOT NULL, DEFAULT 'developer', CHECK (role IN ('admin', 'developer'))` | Authorization role. `admin` can manage all policies; `developer` can only manage their own. The `CHECK` constraint ensures no invalid role value can ever exist in the database. |
| `is_active` | `BOOLEAN` | `NOT NULL, DEFAULT TRUE` | Soft delete / suspend flag. Setting to `FALSE` prevents login without deleting the row (and all its related data). |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL, DEFAULT NOW()` | Record creation timestamp. `TIMESTAMPTZ` = timestamp with time zone. Always store timestamps with timezone — timezone-naive timestamps cause subtle bugs across environments. |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL, DEFAULT NOW()` | Last modification timestamp. Updated via a trigger or application logic on every `UPDATE`. |

#### DDL

```sql
CREATE TABLE users (
    id            BIGSERIAL    PRIMARY KEY,
    email         TEXT         NOT NULL UNIQUE,
    password_hash TEXT         NOT NULL,
    role          TEXT         NOT NULL DEFAULT 'developer'
                               CHECK (role IN ('admin', 'developer')),
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

---

### Table 2: `refresh_tokens`

As decided in `Architecture.md Section 2.2`, access JWTs are short-lived (15 minutes) and stateless. Refresh tokens are long-lived, stored here, and revocable.

#### Column Definitions

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing identifier. |
| `user_id` | `BIGINT` | `NOT NULL, REFERENCES users(id) ON DELETE CASCADE` | Which user this token belongs to. `ON DELETE CASCADE` means: if the user is deleted, all their refresh tokens are automatically deleted too. |
| `token_hash` | `TEXT` | `NOT NULL, UNIQUE` | SHA-256 hash of the refresh token string. The actual token is sent to the client and never stored here — only the hash, so that a database breach does not expose usable tokens. |
| `expires_at` | `TIMESTAMPTZ` | `NOT NULL` | When this refresh token expires. Typically 7–30 days after creation. Expired tokens are rejected even if they are not revoked. |
| `revoked_at` | `TIMESTAMPTZ` | `NULL` | If set, this token has been explicitly revoked (e.g., user logged out). `NULL` means the token is still valid (assuming not expired). |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL, DEFAULT NOW()` | When the token was issued. |

#### DDL

```sql
CREATE TABLE refresh_tokens (
    id          BIGSERIAL    PRIMARY KEY,
    user_id     BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT         NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ  NOT NULL,
    revoked_at  TIMESTAMPTZ  NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

#### Why not store refresh tokens in Redis?

A refresh token must survive a Redis restart (it represents a long-term session). It also must be queryable by `user_id` (to revoke all tokens for a user on password change). These requirements point squarely to PostgreSQL.

---

### Table 3: `api_keys`

API keys are an alternative to JWT login for programmatic access. A user can create multiple API keys (e.g., one per application they are building).

#### Column Definitions

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing identifier. |
| `user_id` | `BIGINT` | `NOT NULL, REFERENCES users(id) ON DELETE CASCADE` | The user who owns this key. Deleting a user cascades and deletes all their API keys. |
| `key_hash` | `TEXT` | `NOT NULL, UNIQUE` | SHA-256 hash of the full API key. The raw key is shown to the user exactly once at creation and never stored. |
| `key_prefix` | `TEXT` | `NOT NULL` | First 8 characters of the raw key (e.g., `"abc12345"`). Stored in plain text for display ("your key ending in abc12345...") without exposing the full key. Also used as the identifier in Redis keys (see `Redis.md Section 3`). |
| `name` | `TEXT` | `NOT NULL` | Human-readable label the user gives the key (e.g., "Production App", "Load Test Key"). Helps identify which key to revoke if one is compromised. |
| `is_active` | `BOOLEAN` | `NOT NULL, DEFAULT TRUE` | Revocation flag. Setting to `FALSE` invalidates the key without deletion. |
| `last_used_at` | `TIMESTAMPTZ` | `NULL` | When the key was last used to authenticate a request. Useful for identifying stale keys. `NULL` means never used. Updated asynchronously (see note below). |
| `expires_at` | `TIMESTAMPTZ` | `NULL` | Optional expiry. `NULL` means the key never expires. If set, the key is rejected after this timestamp even if `is_active` is `TRUE`. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL, DEFAULT NOW()` | Creation timestamp. |

> **Note on `last_used_at`:** Updating this column on every API request would create a write to PostgreSQL on the hot path, which defeats the purpose of the Redis-first architecture. Instead, `last_used_at` is updated asynchronously — either in a background job or fire-and-forget after the response is sent. It is a "best effort" timestamp, not guaranteed to be exact.

#### DDL

```sql
CREATE TABLE api_keys (
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
```

---

### Table 4: `policies`

This is the most important table. It defines the rate limiting rules. Every Redis Lua script derives its parameters — algorithm, limit, window, and more — from a row in this table.

#### Column Definitions

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing identifier. |
| `name` | `TEXT` | `NOT NULL` | Human-readable policy name (e.g., "Login Endpoint Strict", "Default Developer Limit"). Used in the admin dashboard and audit logs. |
| `description` | `TEXT` | `NULL` | Optional longer description. |
| `algorithm` | `TEXT` | `NOT NULL, CHECK (algorithm IN ('fixed_window', 'sliding_window', 'sliding_log', 'token_bucket', 'leaky_bucket'))` | Which rate limiting algorithm to use. The `CHECK` constraint prevents misspellings or unsupported values from ever entering the database. |
| `limit_count` | `INTEGER` | `NOT NULL, CHECK (limit_count > 0)` | The maximum number of requests allowed per window. For Leaky Bucket, this is the queue capacity. Must be positive. |
| `window_seconds` | `INTEGER` | `NOT NULL, CHECK (window_seconds > 0)` | The time window in seconds. Must be positive. |
| `leak_rate_per_second` | `NUMERIC(10,4)` | `NULL` | For Leaky Bucket only: how fast the queue drains (requests per second). `NULL` for all other algorithms. When `NULL` on a Leaky Bucket policy, the application derives the rate as `limit_count / window_seconds`. See `Redis.md Q6`. |
| `identity_type` | `TEXT` | `NOT NULL, CHECK (identity_type IN ('user', 'api_key', 'ip', 'global'))` | Who this policy applies to. `'global'` means every request regardless of identity (useful as a catch-all). |
| `user_id` | `BIGINT` | `NULL, REFERENCES users(id) ON DELETE CASCADE` | If `identity_type = 'user'`, which user this policy applies to. `NULL` for IP and global policies. |
| `ip_address` | `INET` | `NULL` | If `identity_type = 'ip'`, which IP address this policy applies to. `INET` is a PostgreSQL-native type that validates IP format. `NULL` for user and global policies. |
| `endpoint_path` | `TEXT` | `NOT NULL, DEFAULT '*'` | The API endpoint this policy applies to (e.g., `'POST /auth/login'`). `'*'` means all endpoints. |
| `failure_mode` | `TEXT` | `NOT NULL, DEFAULT 'open', CHECK (failure_mode IN ('open', 'closed'))` | What to do when Redis is unreachable. `'open'` passes the request through (see `Redis.md Section 6`). `'closed'` returns HTTP 503. Per-policy so security-sensitive endpoints (e.g., login) can be fail-closed while others remain fail-open. |
| `is_active` | `BOOLEAN` | `NOT NULL, DEFAULT TRUE` | Whether this policy is enforced. Inactive policies are not loaded into the policy cache and do not affect requests. |
| `priority` | `INTEGER` | `NOT NULL, DEFAULT 0` | When multiple policies match a request, the one with the highest `priority` value wins. Default `0` means equal priority. |
| `created_by` | `BIGINT` | `NULL, REFERENCES users(id) ON DELETE SET NULL` | Which admin created this policy. `ON DELETE SET NULL` — if the admin account is deleted, the policy stays but `created_by` becomes `NULL`. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL, DEFAULT NOW()` | Creation timestamp. |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL, DEFAULT NOW()` | Last modified timestamp. |

#### DDL

```sql
CREATE TABLE policies (
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
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Cross-column constraint: leak_rate only makes sense for leaky_bucket
    CONSTRAINT leak_rate_only_for_leaky_bucket
        CHECK (
            (algorithm = 'leaky_bucket')
            OR
            (algorithm != 'leaky_bucket' AND leak_rate_per_second IS NULL)
        ),

    -- Cross-column constraint: user_id required when identity_type is 'user' or 'api_key'
    CONSTRAINT user_id_required_for_user_policies
        CHECK (
            (identity_type IN ('user', 'api_key') AND user_id IS NOT NULL)
            OR
            (identity_type NOT IN ('user', 'api_key'))
        ),

    -- Cross-column constraint: ip_address required when identity_type is 'ip'
    CONSTRAINT ip_address_required_for_ip_policies
        CHECK (
            (identity_type = 'ip' AND ip_address IS NOT NULL)
            OR
            (identity_type != 'ip')
        )
);
```

> **What are cross-column constraints?** A regular `CHECK` constraint validates one column in isolation. A cross-column `CHECK` constraint can reference multiple columns and enforce rules across them. In PostgreSQL, you write these at the table level (after all column definitions) with a `CONSTRAINT name CHECK (...)` clause. They are enforced on every `INSERT` and `UPDATE`, just like column-level constraints.

---

### Table 5: `audit_logs`

Every rate-limiting decision — both allowed and blocked — can generate an audit log entry. This table is the source of truth for the admin analytics dashboard and for debugging abuse.

#### Important Note on Write Volume

Audit logs are **optional on the hot path.** Writing to PostgreSQL on every single request would add 5–20ms of latency to every request — defeating the purpose of the Redis-first architecture. The strategy:

- **Blocked requests** always generate an audit log entry (written asynchronously after the response is sent).
- **Allowed requests** optionally generate an entry based on a sampling rate (e.g., log 1% of allowed requests for trend analysis). This is configurable.
- Log writes are fire-and-forget: the HTTP response is sent to the client first, then the log is written. A failure to log never fails a request.

#### Column Definitions

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Auto-incrementing identifier. |
| `policy_id` | `BIGINT` | `NULL, REFERENCES policies(id) ON DELETE SET NULL` | Which policy was applied. `NULL` if the request was allowed fail-open (Redis was down and no policy could be evaluated). `ON DELETE SET NULL` — audit history is preserved even if a policy is later deleted. |
| `user_id` | `BIGINT` | `NULL` | The authenticated user's ID, if known. Not a foreign key — intentionally denormalised so audit history survives even if the user account is later deleted. |
| `api_key_prefix` | `TEXT` | `NULL` | The API key prefix, if the request used an API key instead of a JWT. |
| `ip_address` | `INET` | `NOT NULL` | The client's IP address. Always captured, regardless of identity type. |
| `endpoint` | `TEXT` | `NOT NULL` | The requested endpoint (method + path), e.g., `'POST /auth/login'`. |
| `algorithm` | `TEXT` | `NULL` | The algorithm that evaluated this request. Denormalised from the policy for historical accuracy — the policy may change algorithm later, but the log should reflect what was used at the time. |
| `outcome` | `TEXT` | `NOT NULL, CHECK (outcome IN ('allowed', 'blocked', 'fail_open'))` | The rate limit decision. `'fail_open'` is a separate outcome for when Redis was down and the request was passed through. |
| `limit_count` | `INTEGER` | `NULL` | The limit at the time of the decision (denormalised). |
| `remaining` | `INTEGER` | `NULL` | Tokens/requests remaining after this decision. |
| `retry_after_seconds` | `INTEGER` | `NULL` | How long to wait before retrying. Only set when `outcome = 'blocked'`. |
| `request_id` | `TEXT` | `NULL` | A unique ID for the request (set by the API server). Enables correlating audit log entries with Winston log entries. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL, DEFAULT NOW()` | When the event occurred. This column drives all time-series queries in analytics. |

#### DDL

```sql
CREATE TABLE audit_logs (
    id                   BIGSERIAL    PRIMARY KEY,
    policy_id            BIGINT       NULL REFERENCES policies(id) ON DELETE SET NULL,
    user_id              BIGINT       NULL,
    api_key_prefix       TEXT         NULL,
    ip_address           INET         NOT NULL,
    endpoint             TEXT         NOT NULL,
    algorithm            TEXT         NULL,
    outcome              TEXT         NOT NULL
                                      CHECK (outcome IN ('allowed', 'blocked', 'fail_open')),
    limit_count          INTEGER      NULL,
    remaining            INTEGER      NULL,
    retry_after_seconds  INTEGER      NULL,
    request_id           TEXT         NULL,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

#### Why is `user_id` in `audit_logs` not a foreign key?

Audit logs are an immutable historical record. If `user_id` were a foreign key referencing `users(id)`, deleting a user account would either:
- **Cascade delete** all their audit history (bad — we lose the record of their activity)
- **Prevent deletion** until audit logs are cleaned up (bad — users have a right to delete their accounts)

By storing `user_id` as a plain `BIGINT` with no foreign key constraint, we decouple the audit history from the user lifecycle. This is an intentional denormalisation — a well-known pattern in audit logging.

---

## 6. Indexing Strategy

### What an Index Does (Plain Terms)

Imagine a phone book. To find "Smith, John" you don't read every entry from page 1 — you flip to the S section, then scan forward. The phone book is indexed alphabetically by last name.

PostgreSQL indexes work the same way. Without an index on `users.email`, a query like `WHERE email = 'test@example.com'` reads every row in the table. With a B-tree index on `email`, PostgreSQL jumps directly to the matching row.

**The cost:** Every index is a separate data structure that must be updated every time a row is inserted, updated, or deleted. Indexes are free for reads, not for writes. Add them only where queries actually need them.

---

### Index Definitions

#### `users` Table

```sql
-- Already covered by the UNIQUE constraint (PostgreSQL creates a unique index automatically):
-- CREATE UNIQUE INDEX ON users(email);

-- Useful for admin dashboard: filter users by role
CREATE INDEX idx_users_role ON users(role);

-- Useful for login check: filter out inactive accounts
CREATE INDEX idx_users_is_active ON users(is_active);
```

**Why `email` does not need a separate index:** PostgreSQL automatically creates a unique index when you declare `UNIQUE`. The `UNIQUE` constraint and its backing index are the same thing.

---

#### `refresh_tokens` Table

```sql
-- Already covered by UNIQUE constraint on token_hash.

-- Used by logout: revoke all tokens for a user
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- Used by cleanup job: delete expired tokens
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
```

---

#### `api_keys` Table

```sql
-- Already covered by UNIQUE constraint on key_hash.

-- Used frequently: look up all keys for a user (admin dashboard, key listing)
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);

-- Used on auth hot path: filter out inactive/expired keys quickly
-- Partial index: only indexes rows where is_active = TRUE
-- Much smaller than a full index — active keys are a subset of all keys
CREATE INDEX idx_api_keys_active ON api_keys(key_hash) WHERE is_active = TRUE;
```

> **What is a partial index?** A standard index covers every row in the table. A partial index only covers rows matching a `WHERE` condition. If 90% of API keys are revoked over time but only active keys are queried on the auth path, a partial index on `WHERE is_active = TRUE` is significantly smaller and faster than a full index.

---

#### `policies` Table

```sql
-- The single most important index in the system.
-- Policy lookup query: "find the active policy for this user and endpoint"
-- This index is hit on every cache miss — potentially thousands of times per second.
CREATE INDEX idx_policies_lookup
    ON policies(identity_type, user_id, endpoint_path)
    WHERE is_active = TRUE;

-- For IP-based policy lookup
CREATE INDEX idx_policies_ip_lookup
    ON policies(ip_address, endpoint_path)
    WHERE is_active = TRUE AND identity_type = 'ip';

-- For admin dashboard: list all policies ordered by creation date
CREATE INDEX idx_policies_created_at ON policies(created_at DESC);
```

**Why `WHERE is_active = TRUE` on the lookup index?** Inactive policies are never queried on the hot path. A partial index that excludes inactive policies is smaller (fewer rows) and faster to search. As you deactivate old policies over time, the hot-path index stays lean.

---

#### `audit_logs` Table

```sql
-- The most important analytics index: time-series queries
-- "How many blocked requests in the last hour?"
-- "Show me all events for user 123 today"
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- For user-specific analytics
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id)
    WHERE user_id IS NOT NULL;

-- For endpoint-specific analytics
CREATE INDEX idx_audit_logs_endpoint ON audit_logs(endpoint, created_at DESC);

-- For outcome-specific filtering ("show me all blocked requests")
CREATE INDEX idx_audit_logs_outcome ON audit_logs(outcome, created_at DESC);
```

**Why `created_at DESC` in audit log indexes?** Analytics queries almost always ask about recent events ("last hour", "today", "last 7 days"). A descending index starts from the most recent row and works backwards — exactly how these queries scan. It is marginally faster for `ORDER BY created_at DESC LIMIT 100` than an ascending index.

---

### Index Summary Table

| Table | Index | Columns | Type | Why |
|---|---|---|---|---|
| `users` | _(auto from UNIQUE)_ | `email` | Unique B-tree | Login lookup |
| `users` | `idx_users_role` | `role` | B-tree | Admin dashboard filtering |
| `refresh_tokens` | _(auto from UNIQUE)_ | `token_hash` | Unique B-tree | Token validation |
| `refresh_tokens` | `idx_refresh_tokens_user_id` | `user_id` | B-tree | Revoke all user tokens |
| `refresh_tokens` | `idx_refresh_tokens_expires_at` | `expires_at` | B-tree | Cleanup expired tokens |
| `api_keys` | _(auto from UNIQUE)_ | `key_hash` | Unique B-tree | Key validation |
| `api_keys` | `idx_api_keys_user_id` | `user_id` | B-tree | List user's keys |
| `api_keys` | `idx_api_keys_active` | `key_hash` WHERE active | Partial B-tree | Fast active-key auth |
| `policies` | `idx_policies_lookup` | `identity_type, user_id, endpoint_path` WHERE active | Partial B-tree | **Hot path: policy cache miss** |
| `policies` | `idx_policies_ip_lookup` | `ip_address, endpoint_path` WHERE active + ip | Partial B-tree | IP policy lookup |
| `policies` | `idx_policies_created_at` | `created_at DESC` | B-tree | Admin listing |
| `audit_logs` | `idx_audit_logs_created_at` | `created_at DESC` | B-tree | Time-series analytics |
| `audit_logs` | `idx_audit_logs_user_id` | `user_id` WHERE not null | Partial B-tree | Per-user analytics |
| `audit_logs` | `idx_audit_logs_endpoint` | `endpoint, created_at DESC` | B-tree | Per-endpoint analytics |
| `audit_logs` | `idx_audit_logs_outcome` | `outcome, created_at DESC` | B-tree | Outcome filtering |

---

## 7. How Policy Lookups Work End-to-End

This section ties the schema back to `Architecture.md Section 3.3` — the 30-second in-process policy cache. Understanding this flow is critical because it shows why the schema design (especially the indexes and the `priority` column) directly affects request latency.

### The Full Flow

```
Request arrives: POST /auth/login
Authenticated as: user_id = 123

Step 1: Build cache key
        cacheKey = "policy:user:123:POST /auth/login"

Step 2: Check in-memory cache (lives inside Node.js process)
        Does cacheKey exist in cache AND is it less than 30 seconds old?

        YES (cache hit):
            Use cached policy object
            Skip PostgreSQL entirely
            Proceed to Redis Lua script

        NO (cache miss):
            Proceed to Step 3

Step 3: Query PostgreSQL

        SELECT *
        FROM policies
        WHERE is_active = TRUE
          AND identity_type = 'user'
          AND user_id = 123
          AND (endpoint_path = 'POST /auth/login' OR endpoint_path = '*')
        ORDER BY
            endpoint_path != '*' DESC,  -- exact match wins over wildcard
            priority DESC               -- higher priority wins among ties
        LIMIT 1;

        This query hits idx_policies_lookup (the partial index on identity_type,
        user_id, endpoint_path WHERE is_active = TRUE).
        Expected execution time: < 1ms with the index.

Step 4: Store result in cache
        cache.set(cacheKey, policyRow, { ttl: 30_000 })  // 30 seconds

Step 5: Use policy
        algorithm     = policyRow.algorithm          // 'fixed_window'
        limit         = policyRow.limit_count        // 5
        window        = policyRow.window_seconds     // 60
        failureMode   = policyRow.failure_mode       // 'closed' (login is sensitive!)
        Proceed to Redis Lua script
```

### Policy Resolution Priority

When multiple policies could match a request, the `ORDER BY` clause resolves the ambiguity:

1. **Exact endpoint match over wildcard** — `'POST /auth/login'` beats `'*'`
2. **Higher `priority` value wins** — allows admins to explicitly set precedence when two exact-match policies exist for the same endpoint

This ordering is deterministic: the same request always resolves to the same policy, regardless of insertion order.

### What Happens on a Cache Miss for an Unknown User?

If no policy matches the user and endpoint (e.g., a new user with no specific policy), the query returns 0 rows. The application falls back to:

1. A global policy (`identity_type = 'global'`) if one exists
2. A default hardcoded policy (a code constant): 100 requests per 60 seconds, Fixed Window, fail-open

This fallback ensures the rate limiter always has a policy to apply — there is no unprotected state.

---

## 8. Migration Strategy

### What is a Database Migration?

A database migration is a versioned, ordered script that modifies the database schema. Instead of writing raw SQL and running it manually, you use a migration tool that:

- Tracks which migrations have already been applied (in a special `migrations` table it manages)
- Applies new migrations in order on `migrate up`
- Can undo migrations on `migrate down` (if you write reversible migrations)
- Ensures every environment (development, CI, production) runs the same schema in the same order

Without migrations, "what schema does production have?" becomes a question only answerable by inspecting the live database. With migrations, the answer is in version control.

### Chosen Tool: `node-postgres-migrate` via `db-migrate`

**Decision: Use `db-migrate` with the `pg` driver.**

`db-migrate` is the most established migration library in the Node.js ecosystem for PostgreSQL. It:
- Stores migration state in a `migrations` table it creates automatically
- Supports `up` (apply) and `down` (rollback) methods per migration
- Works with plain SQL or JavaScript
- Has no magic — migrations are just SQL files with a timestamp prefix

**Alternative considered — Knex.js migrations:** Knex is a query builder that also has migration support. It is more integrated (you write migrations in JavaScript using Knex's fluent API). For a project that is also learning PostgreSQL, plain SQL migrations are more educational — you can read them and understand exactly what they do without learning a DSL.

### Migration File Structure

```
backend/
  db/
    migrations/
      001_create_users.sql
      002_create_refresh_tokens.sql
      003_create_api_keys.sql
      004_create_policies.sql
      005_create_audit_logs.sql
      006_create_indexes.sql
    seeds/
      001_seed_admin_user.sql
      002_seed_default_policies.sql
```

Each migration file has:
- A numeric prefix ensuring order (`001_`, `002_`, etc.)
- A descriptive name
- Both an `-- up` section (apply the change) and a `-- down` section (reverse it)

### Example Migration Format

```sql
-- 001_create_users.sql

-- up
CREATE TABLE users (
    id            BIGSERIAL    PRIMARY KEY,
    email         TEXT         NOT NULL UNIQUE,
    password_hash TEXT         NOT NULL,
    role          TEXT         NOT NULL DEFAULT 'developer'
                               CHECK (role IN ('admin', 'developer')),
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- down
DROP TABLE IF EXISTS users;
```

### Migration Principles

1. **Migrations are append-only.** Never edit an already-applied migration file. If you need to change the schema, write a new migration.

2. **Every `down` must be the inverse of `up`.** If `up` adds a column, `down` drops it. If `up` creates a table, `down` drops it. This ensures clean rollbacks.

3. **Migrations run automatically on startup** in development (via a startup script that calls `db-migrate up`). In production, they are run as a separate step before deploying the new server version — never automatically on server startup, because a failed migration should stop the deployment, not leave the server in a half-migrated state.

4. **Seed data is separate from migrations.** Schema migrations (`001_create_users.sql`) are always applied. Seed data (test users, default policies) is only applied in development and CI. They live in `db/seeds/` and are run separately.

### Running Migrations

```bash
# Apply all pending migrations
npm run db:migrate

# Roll back the most recent migration
npm run db:rollback

# Apply seed data (development only)
npm run db:seed
```

These commands are defined in `package.json` and documented in `docs/Deployment.md`.

---

## 9. Entity Relationship Diagram

```
+------------------+          +---------------------+
|     users        |          |   refresh_tokens    |
+------------------+          +---------------------+
| id (PK)          |<---------| id (PK)             |
| email            |  1     * | user_id (FK)        |
| password_hash    |          | token_hash          |
| role             |          | expires_at          |
| is_active        |          | revoked_at          |
| created_at       |          | created_at          |
| updated_at       |          +---------------------+
+--------+---------+
         |                    +---------------------+
         | 1                  |     api_keys        |
         |                    +---------------------+
         *<-------------------| id (PK)             |
                              | user_id (FK)        |
                              | key_hash            |
                              | key_prefix          |
                              | name                |
                              | is_active           |
                              | last_used_at        |
                              | expires_at          |
                              | created_at          |
                              +---------------------+

+------------------+          +---------------------+
|     users        |          |      policies       |
+------------------+          +---------------------+
| id (PK)          |<---------| id (PK)             |
|                  |  0..1  * | user_id (FK, NULL)  |
|                  |          | name                |
|                  |          | algorithm           |
|                  |          | limit_count         |
|                  |          | window_seconds      |
|                  |          | leak_rate_per_second|
|                  |          | identity_type       |
|                  |          | ip_address          |
|                  |          | endpoint_path       |
|                  |          | failure_mode        |
|                  |          | is_active           |
|                  |          | priority            |
|                  |<---------| created_by (FK,NULL)|
|                  |          | created_at          |
+------------------+          | updated_at          |
                              +----------+----------+
                                         |
                                         | 0..1
                                         |
                              +----------v----------+
                              |     audit_logs      |
                              +---------------------+
                              | id (PK)             |
                              | policy_id (FK,NULL) |
                              | user_id (plain INT) |
                              | api_key_prefix      |
                              | ip_address          |
                              | endpoint            |
                              | algorithm           |
                              | outcome             |
                              | limit_count         |
                              | remaining           |
                              | retry_after_seconds |
                              | request_id          |
                              | created_at          |
                              +---------------------+
```

**Reading the diagram:**
- `1` and `*` at the ends of lines indicate cardinality: `1` user has `*` (many) refresh tokens.
- `0..1` means zero or one: a policy has zero or one user (IP and global policies have none).
- `(FK)` = foreign key. `(FK, NULL)` = nullable foreign key.
- `audit_logs.user_id` has no FK line deliberately — it is a plain integer, not a relational reference.

---

*Related documents:*
- [`docs/Architecture.md`](./Architecture.md) — System overview and the Redis vs PostgreSQL split
- [`docs/Redis.md`](./Redis.md) — Redis key design, TTL strategy, and the open questions resolved here
- [`docs/API.md`](./API.md) — Endpoint definitions, request/response shapes, and how policies are exposed via the REST API
