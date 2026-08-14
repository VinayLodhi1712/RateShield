# API Reference — RateShield

**Version:** 1.0  
**Date:** 2026-07-30  
**Author:** Vinay Anand Lodhi  
**Status:** Draft — pending review

---

## Table of Contents

1. [What This Document Covers](#1-what-this-document-covers)
2. [API Conventions](#2-api-conventions)
3. [Authentication & Authorisation](#3-authentication--authorisation)
4. [Standard Response Envelopes](#4-standard-response-envelopes)
5. [Rate Limit Response Headers](#5-rate-limit-response-headers)
6. [Auth Endpoints](#6-auth-endpoints)
7. [API Key Endpoints](#7-api-key-endpoints)
8. [Policy Endpoints](#8-policy-endpoints)
9. [Rate Limit Status Endpoints](#9-rate-limit-status-endpoints)
10. [Admin & Metrics Endpoints](#10-admin--metrics-endpoints)
11. [HTTP Status Code Reference](#11-http-status-code-reference)
12. [Swagger / OpenAPI Generation](#12-swagger--openapi-generation)
13. [API Versioning](#13-api-versioning)

---

## 1. What This Document Covers

`Architecture.md` described the request flow. `Database.md` described the schema. This document describes the HTTP surface of RateShield — every endpoint a client can call, what it expects, and what it returns.

After reading this document you should be able to:

- Know exactly which endpoints exist and what each one does.
- Understand the authentication requirement for each endpoint.
- Know the exact JSON shape of every request and response, including error responses.
- Understand what `429 Too Many Requests` and `503 Service Unavailable` look like and why they happen.
- Know how Swagger documentation is generated and where to read it.

This document does not contain Node.js code. Request/response shapes are shown as JSON examples. Validation rules are stated in plain English, mirroring the `CHECK` constraints in `Database.md` exactly — so there is one source of truth for what is valid.

---

## 2. API Conventions

### Base URL

In local development (Docker Compose):

```
http://localhost:3000
```

All endpoints are relative to this base. No path prefix like `/v1/` is used in v1. See [Section 13](#13-api-versioning) for the rationale.

### Content Type

All request bodies and response bodies use JSON:

```
Content-Type: application/json
Accept: application/json
```

The exception is `GET /metrics` (Prometheus scrape endpoint), which returns plain text in the Prometheus exposition format.

### Request ID

Every request is assigned a unique `X-Request-Id` header by the server. This ID appears in:
- The response headers
- Winston structured logs (`requestId` field)
- `audit_logs.request_id` (for blocked requests)

This makes it possible to correlate a client error report with a specific log line.

### Timestamps

All timestamps in responses are in **ISO 8601 format with UTC timezone**:

```
"createdAt": "2026-07-30T09:00:00.000Z"
```

Never return Unix timestamps in responses (they are used internally in Redis keys but are not human-readable).

### Pagination

List endpoints (`GET /api-keys`, `GET /policies`, `GET /admin/audit-logs`) support cursor-based pagination via query parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `20` | Number of results to return. Max `100`. |
| `cursor` | string | none | Opaque cursor returned by the previous page. Pass this to get the next page. |

Paginated responses include a `meta` object:

```json
{
  "data": [...],
  "meta": {
    "limit": 20,
    "nextCursor": "eyJpZCI6NDJ9",
    "hasMore": true
  }
}
```

When `hasMore` is `false`, there are no more results. `nextCursor` is `null` on the last page.

## 3. Authentication & Authorisation

### Two Auth Methods

RateShield supports two ways for a client to prove identity:

**1. Bearer JWT (for interactive/dashboard clients)**

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Access tokens expire in **15 minutes**. Use `POST /auth/refresh` to get a new one without re-logging in. See `Architecture.md Section 2.2` for why the expiry is short and there is no Redis blacklist.

**2. API Key (for programmatic/service clients)**

```
X-Api-Key: rs_abc12345def67890ghijklmnopqrstuv
```

API keys do not expire unless an `expiresAt` was set when the key was created. Keys begin with the prefix `rs_` to make them identifiable in logs and code reviews.

### Auth Requirement Levels

| Level | Symbol Used in This Doc | Meaning |
|---|---|---|
| None | `(public)` | No authentication required |
| Authenticated | `(auth)` | Valid JWT or API key required |
| Admin only | `(admin)` | Valid JWT required AND `role = 'admin'` in the users table |

### The Three-Stage Request Pipeline

Every request passes through exactly three layers, in this order. Understanding the order is essential for understanding how anonymous requests, invalid credentials, and rate limiting interact.

```
Request arrives
       |
       v
┌──────────────────────────────────────────────────────────┐
│ STAGE 1: Auth Middleware (always runs, always first)     │
│                                                          │
│  Attempts to decode the JWT or look up the API key.      │
│  This is a local cryptographic check — ~0.1ms, zero      │
│  Redis calls, zero database trips.                       │
│                                                          │
│  CASE A — Valid credentials:                             │
│    req.user = { id: 123, role: 'developer' }             │
│    identityKey = 'user:123'                              │
│    → Continue to Stage 2                                 │
│                                                          │
│  CASE B — No credentials (anonymous request):            │
│    req.user = null                                       │
│    identityKey = 'ip:203.0.113.42'                       │
│    → Continue to Stage 2  ← NOT rejected here           │
│                                                          │
│  CASE C — Invalid credentials (bad/expired token):       │
│    → Return 401 immediately, skip Stages 2 and 3        │
│    (No Redis call wasted on an invalid request)          │
└──────────────────────────────────────────────────────────┘
       |
       v
┌──────────────────────────────────────────────────────────┐
│ STAGE 2: Rate Limit Middleware (always runs)             │
│                                                          │
│  Uses identityKey set by Stage 1:                        │
│  • 'user:{id}'     → look up per-user policy             │
│  • 'apikey:{pfx}'  → look up per-key policy              │
│  • 'ip:{addr}'     → look up IP or global policy         │
│                                                          │
│  Executes Redis Lua script atomically.                   │
│                                                          │
│  RESULT — within limit:                                  │
│    → Continue to Stage 3                                 │
│                                                          │
│  RESULT — over limit:                                    │
│    → Return 429 immediately, skip Stage 3               │
│    (Auth guard is never reached for throttled requests)  │
└──────────────────────────────────────────────────────────┘
       |
       v
┌──────────────────────────────────────────────────────────┐
│ STAGE 3: Auth Guard + Route Handler                      │
│                                                          │
│  If route requires (auth) AND req.user is null:          │
│    → Return 401 MISSING_CREDENTIALS                      │
│                                                          │
│  If route requires (admin) AND req.user.role ≠ 'admin':  │
│    → Return 403 INSUFFICIENT_ROLE                        │
│                                                          │
│  Otherwise: execute business logic, return response.     │
└──────────────────────────────────────────────────────────┘
```

**Why does auth middleware decode before the rate limiter, even for anonymous requests?**

JWT verification is a local operation — it verifies a cryptographic signature against a secret that is already in memory. It costs ~0.1ms and needs no network. Running it first means the rate limiter always knows the exact identity (`user:123` or `ip:...`) before touching Redis. If auth ran after the rate limiter, an authenticated user would be rate-limited against their IP address instead of their user identity, making per-user policies impossible.

**Why does the auth guard run *after* the rate limiter, not before?**

Because we need to rate-limit anonymous probes of protected endpoints too. An attacker sending thousands of requests to `GET /admin/users` would receive `401 MISSING_CREDENTIALS` on each — with no throttling — if the auth guard ran before the rate limiter. By running the rate limiter first, we count and throttle these probes under an IP policy before the guard fires. See `Architecture.md Section 2.2` for the full rationale.

**Key distinction: auth middleware ≠ auth guard.** Stage 1 (auth middleware) decodes credentials and sets `req.user` — it never rejects an anonymous request. Stage 3 (auth guard) is a per-route check that rejects requests where `req.user` is null on a protected route. These are different concerns at different positions in the pipeline.

**Practical result — what every request type sees:**

| Request Type | Credentials | Stage 1 result | Stage 2 identity | Final Response |
|---|---|---|---|---|
| Anonymous → `(public)` endpoint | None | `req.user = null` | `ip:{clientIp}` | Rate limited if over limit; otherwise processed |
| Anonymous → `(auth)` endpoint | None | `req.user = null` | `ip:{clientIp}` | Rate limited if over limit; otherwise `401 MISSING_CREDENTIALS` |
| Authenticated → any endpoint | Valid JWT/API key | `req.user = { id, role }` | `user:{id}` | Rate limited if over limit; otherwise processed |
| Invalid credentials → any endpoint | Bad/expired JWT | 401 returned | *(skipped)* | `401` — no Redis call |

**What IP policy is used for anonymous requests?**

The policy resolution order (executed in Stage 2) for a request where `req.user = null`:

1. `identity_type = 'ip'` policy matching the client's IP and the exact `endpoint_path` — highest `priority` wins
2. `identity_type = 'ip'` policy with `ip_address = '0.0.0.0/0'` (CIDR wildcard) and matching endpoint
3. `identity_type = 'global'` policy (applies to all identities and endpoints)
4. Hardcoded default: 100 requests per 60 seconds, Fixed Window, fail-open

An admin can create a tight IP policy for `POST /auth/login` (e.g., 5 req/min, Sliding Log, fail-closed) — which throttles brute-force attempts even from clients who never present a JWT. See `Database.md Section 7` for the policy resolution SQL query.

### What Happens on Auth Failure (Stage 1 — Invalid Credentials)

These scenarios are handled in Stage 1. The request never reaches Stage 2 (rate limiter) or Stage 3 (route handler):

| Scenario | Status | Error Code |
|---|---|---|
| JWT is malformed or has invalid signature | `401` | `INVALID_TOKEN` |
| JWT has expired | `401` | `TOKEN_EXPIRED` |
| API key is not found in the database | `401` | `INVALID_API_KEY` |
| API key is revoked (`is_active = false`) | `401` | `API_KEY_REVOKED` |
| API key has expired (`expires_at` in the past) | `401` | `API_KEY_EXPIRED` |
| User account is suspended (`is_active = false`) | `401` | `ACCOUNT_SUSPENDED` |

> **Note:** A completely absent credential (no `Authorization` header, no `X-Api-Key`) is **not** a Stage 1 failure — it is the anonymous path (CASE B). The request proceeds to Stage 2 with `req.user = null`. The `401 MISSING_CREDENTIALS` only fires in Stage 3, and only for routes that require `(auth)`.

### What Happens on Auth Guard Failure (Stage 3 — Insufficient Access)

These scenarios occur after the rate limiter has already run:

| Scenario | Status | Error Code |
|---|---|---|
| Route requires `(auth)`, request is anonymous | `401` | `MISSING_CREDENTIALS` |
| Route requires `(admin)`, user role is `developer` | `403` | `INSUFFICIENT_ROLE` |

---

## 4. Standard Response Envelopes

All responses use a consistent wrapper shape. This makes it easy to write client-side error handling once and reuse it everywhere.

### Success Response

```json
{
  "success": true,
  "data": { ... }
}
```

For list endpoints:

```json
{
  "success": true,
  "data": [...],
  "meta": {
    "limit": 20,
    "nextCursor": "eyJpZCI6NDJ9",
    "hasMore": true
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description of what went wrong.",
    "details": [
      {
        "field": "algorithm",
        "message": "must be one of: fixed_window, sliding_window, sliding_log, token_bucket, leaky_bucket"
      }
    ]
  }
}
```

- `code` — machine-readable error identifier (use this in client code, not `message`).
- `message` — human-readable explanation, safe to display to developers.
- `details` — optional array of field-level validation errors. Present when `code = "VALIDATION_ERROR"`, absent otherwise.

---

## 5. Rate Limit Response Headers

Every response from a rate-limited endpoint includes these headers, whether the request was allowed or blocked. This lets clients adapt their behaviour without waiting to hit a 429.

| Header | Type | Description |
|---|---|---|
| `X-RateLimit-Limit` | integer | The maximum number of requests allowed in the current window (from `policies.limit_count`). |
| `X-RateLimit-Remaining` | integer | Requests (or tokens) remaining in the current window. `0` when the request is blocked. |
| `X-RateLimit-Reset` | integer | Unix timestamp (seconds) when the current window resets and `Remaining` returns to `Limit`. For Token Bucket, this is when the next token will be available. |
| `X-RateLimit-Algorithm` | string | The algorithm that evaluated this request (e.g., `token_bucket`). Useful for debugging which policy matched. |
| `Retry-After` | integer | **Only on 429 responses.** Number of seconds to wait before retrying. Mirrors `X-RateLimit-Reset - now`. |

### Example: Allowed Request Headers

```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 63
X-RateLimit-Reset: 1722345660
X-RateLimit-Algorithm: token_bucket
X-Request-Id: req_7f3b9a2c
```

### Example: 429 Response Headers

```http
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1722345660
X-RateLimit-Algorithm: token_bucket
Retry-After: 42
X-Request-Id: req_8d4c1e7a
```

See `Architecture.md Section 3.1` and `3.2` for the full request flow that generates these headers.

---

## 6. Auth Endpoints

> **Auth endpoints are NOT themselves rate-limited by the general middleware** — they have their own tightly-controlled policies applied first. The login and register endpoints should have a Sliding Log or Fixed Window policy with `failure_mode = 'closed'` to prevent brute-force attacks even during a Redis outage. See `Database.md Section 4, Q3`.

---

### POST /auth/register

**Auth:** `(public)`  
**Description:** Create a new user account. The new user is always created with `role = 'developer'`. Admin accounts are created by an existing admin via `PATCH /admin/users/:id`.

#### Request Body

| Field | Type | Required | Validation |
|---|---|---|---|
| `email` | string | ✓ | Valid email format. `UNIQUE` in the `users` table — returns `409` if already registered. |
| `password` | string | ✓ | Minimum 8 characters. Not stored; bcrypt hash is stored in `password_hash`. |

```json
POST /auth/register
Content-Type: application/json

{
  "email": "vinay@example.com",
  "password": "mySecurePass123"
}
```

#### Success Response — `201 Created`

```json
{
  "success": true,
  "data": {
    "user": {
      "id": 1,
      "email": "vinay@example.com",
      "role": "developer",
      "isActive": true,
      "createdAt": "2026-07-30T09:00:00.000Z"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "rt_7f3b9a2c4d5e6f7a8b9c0d1e2f3a4b5c..."
  }
}
```

> **Security note:** The `refreshToken` is shown here exactly once. It is not stored in plaintext anywhere on the server — only its SHA-256 hash is in the `refresh_tokens` table. The client must store it securely (e.g., `HttpOnly` cookie, not `localStorage`).

#### Error Responses

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Email format invalid or password too short |
| `409` | `EMAIL_ALREADY_EXISTS` | An account with this email already exists |
| `429` | `RATE_LIMITED` | Registration rate limit exceeded |

---

### POST /auth/login

**Auth:** `(public)`  
**Description:** Authenticate with email and password. Returns a short-lived access token and a long-lived refresh token.

#### Request Body

| Field | Type | Required | Validation |
|---|---|---|---|
| `email` | string | ✓ | Must be a registered email |
| `password` | string | ✓ | Must match the stored bcrypt hash |

```json
POST /auth/login
Content-Type: application/json

{
  "email": "vinay@example.com",
  "password": "mySecurePass123"
}
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": {
    "user": {
      "id": 1,
      "email": "vinay@example.com",
      "role": "developer"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "accessTokenExpiresAt": "2026-07-30T09:15:00.000Z",
    "refreshToken": "rt_7f3b9a2c4d5e6f7a8b9c0d1e2f3a4b5c...",
    "refreshTokenExpiresAt": "2026-08-06T09:00:00.000Z"
  }
}
```

#### Error Responses

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Missing email or password field |
| `401` | `INVALID_CREDENTIALS` | Email not found, wrong password, or account suspended. **Always return the same vague message** — do not reveal whether the email exists. |
| `429` | `RATE_LIMITED` | Login rate limit exceeded (should have `failure_mode = 'closed'`) |

> **Why not distinguish "user not found" from "wrong password"?** Separating these responses tells an attacker which emails are registered. Always return the same `INVALID_CREDENTIALS` error for both cases. This is a standard security practice called credential stuffing prevention.

---

### POST /auth/refresh

**Auth:** `(public)` — refresh token is the credential  
**Description:** Exchange a valid, non-expired refresh token for a new access token. Implements refresh token rotation: the old refresh token is revoked and a new one is issued.

#### Request Body

| Field | Type | Required | Validation |
|---|---|---|---|
| `refreshToken` | string | ✓ | Must match a non-revoked, non-expired row in `refresh_tokens` |

```json
POST /auth/refresh
Content-Type: application/json

{
  "refreshToken": "rt_7f3b9a2c4d5e6f7a8b9c0d1e2f3a4b5c..."
}
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "accessTokenExpiresAt": "2026-07-30T09:30:00.000Z",
    "refreshToken": "rt_new9a2c4d5e6f7a8b9c0d1e2f3a4b5c...",
    "refreshTokenExpiresAt": "2026-08-06T09:15:00.000Z"
  }
}
```

#### Error Responses

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | `refreshToken` field is missing |
| `401` | `INVALID_REFRESH_TOKEN` | Token not found in the database |
| `401` | `REFRESH_TOKEN_EXPIRED` | Token found but `expires_at` is in the past |
| `401` | `REFRESH_TOKEN_REVOKED` | Token found but `revoked_at` is set |

> **What is refresh token rotation?** Every call to `/auth/refresh` invalidates the old refresh token and issues a new one. If an attacker steals a refresh token and uses it, the legitimate user's next refresh will fail (their token was already used), alerting them. Without rotation, a stolen refresh token is valid until its natural expiry.

---

### POST /auth/logout

**Auth:** `(auth)` — JWT or API key  
**Description:** Revoke the current refresh token, effectively ending the session. The access token remains valid until its 15-minute natural expiry — this is a deliberate trade-off of the no-blacklist design (see `Architecture.md Section 2.2`).

#### Request Body

| Field | Type | Required | Validation |
|---|---|---|---|
| `refreshToken` | string | ✓ | The refresh token to revoke |

```json
POST /auth/logout
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "refreshToken": "rt_7f3b9a2c4d5e6f7a8b9c0d1e2f3a4b5c..."
}
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": {
    "message": "Logged out successfully."
  }
}
```

#### Error Responses

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | `refreshToken` field missing |
| `401` | `MISSING_CREDENTIALS` | No JWT provided |
| `404` | `REFRESH_TOKEN_NOT_FOUND` | Token does not belong to the authenticated user |

---

## 7. API Key Endpoints

> API key management endpoints require JWT authentication (not API key authentication). You cannot use an API key to manage API keys — this prevents a compromised key from creating new keys.

---

### POST /api-keys

**Auth:** `(auth)` — JWT only  
**Description:** Create a new API key for the authenticated user. The full key is returned exactly once and never stored on the server.

#### Request Body

| Field | Type | Required | Validation |
|---|---|---|---|
| `name` | string | ✓ | 1–100 characters. Human-readable label. |
| `expiresAt` | ISO 8601 string | ✗ | Must be in the future. If omitted, key never expires. |

```json
POST /api-keys
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "name": "Production App",
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

#### Success Response — `201 Created`

```json
{
  "success": true,
  "data": {
    "apiKey": {
      "id": 3,
      "name": "Production App",
      "prefix": "rs_abc123",
      "key": "rs_abc12345def67890ghijklmnopqrstuv",
      "isActive": true,
      "expiresAt": "2027-01-01T00:00:00.000Z",
      "createdAt": "2026-07-30T09:00:00.000Z"
    },
    "warning": "Save this key now — it will not be shown again."
  }
}
```

> The `key` field is present only in this creation response. Subsequent `GET /api-keys` responses will never return the full key — only `prefix`.

#### Error Responses

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | `name` missing, too long, or `expiresAt` is in the past |
| `401` | `MISSING_CREDENTIALS` | No JWT provided |

---

### GET /api-keys

**Auth:** `(auth)` — JWT only  
**Description:** List all API keys for the authenticated user. Does not return full key values — only metadata for display.

#### Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `20` | Results per page (max 100) |
| `cursor` | string | none | Pagination cursor |
| `includeInactive` | boolean | `false` | If `true`, includes revoked keys |

```
GET /api-keys?limit=10&includeInactive=false
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "id": 3,
      "name": "Production App",
      "prefix": "rs_abc123",
      "isActive": true,
      "lastUsedAt": "2026-07-30T08:45:00.000Z",
      "expiresAt": "2027-01-01T00:00:00.000Z",
      "createdAt": "2026-07-30T09:00:00.000Z"
    },
    {
      "id": 1,
      "name": "Old Test Key",
      "prefix": "rs_xyz789",
      "isActive": false,
      "lastUsedAt": "2026-06-01T10:00:00.000Z",
      "expiresAt": null,
      "createdAt": "2026-06-01T09:00:00.000Z"
    }
  ],
  "meta": {
    "limit": 10,
    "nextCursor": null,
    "hasMore": false
  }
}
```

---

### DELETE /api-keys/:id

**Auth:** `(auth)` — JWT only  
**Description:** Revoke an API key. This sets `is_active = false` on the `api_keys` row — it does not delete the row, preserving the audit trail. Revocation takes effect immediately (no 30-second cache delay — API key lookups hit the database, not the policy cache).

```
DELETE /api-keys/3
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": {
    "message": "API key rs_abc123 revoked successfully.",
    "revokedAt": "2026-07-30T09:30:00.000Z"
  }
}
```

#### Error Responses

| Status | Code | When |
|---|---|---|
| `401` | `MISSING_CREDENTIALS` | No JWT |
| `403` | `FORBIDDEN` | The key exists but belongs to a different user |
| `404` | `NOT_FOUND` | No API key with this `id` |
| `409` | `ALREADY_REVOKED` | Key is already inactive |

---

## 8. Policy Endpoints

Policies are the heart of RateShield. They define who gets rate-limited, by which algorithm, at what limit, on which endpoint.

**Authorisation rules:**
- `GET` (read): any authenticated user. Developers see only their own policies; admins see all.
- `POST`, `PATCH`, `DELETE` (write): admin only.

---

### POST /policies

**Auth:** `(admin)`  
**Description:** Create a new rate limit policy. Validation rules mirror the `CHECK` constraints in the `policies` table exactly — there is one source of truth.

#### Request Body

| Field | Type | Required | Validation | Source of Truth |
|---|---|---|---|---|
| `name` | string | ✓ | 1–200 chars | Application layer |
| `description` | string | ✗ | Any text | Application layer |
| `algorithm` | string | ✓ | One of: `fixed_window`, `sliding_window`, `sliding_log`, `token_bucket`, `leaky_bucket` | `CHECK` constraint in `policies` |
| `limitCount` | integer | ✓ | Must be `> 0` | `CHECK (limit_count > 0)` in `policies` |
| `windowSeconds` | integer | ✓ | Must be `> 0`. Defaults to `60` if omitted. | `CHECK (window_seconds > 0)` in `policies` |
| `leakRatePerSecond` | number | ✗ | Required if `algorithm = 'leaky_bucket'`. Must be `> 0`. Must be `null`/absent for all other algorithms. | Cross-column constraint `leak_rate_only_for_leaky_bucket` |
| `identityType` | string | ✓ | One of: `user`, `api_key`, `ip`, `global` | `CHECK` constraint in `policies` |
| `userId` | integer | ✗ | Required if `identityType = 'user'` or `'api_key'` | Cross-column constraint `user_id_required_for_user_policies` |
| `ipAddress` | string | ✗ | Required if `identityType = 'ip'`. Must be valid IPv4 or IPv6 | Cross-column constraint `ip_address_required_for_ip_policies` |
| `endpointPath` | string | ✗ | e.g., `"POST /auth/login"`. Defaults to `"*"` (all endpoints) | Defaults in `policies` |
| `failureMode` | string | ✗ | `"open"` or `"closed"`. Defaults to `"open"`. | `CHECK` constraint in `policies` |
| `priority` | integer | ✗ | Any integer. Higher wins. Defaults to `0`. | Application layer |

```json
POST /policies
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "name": "Login Endpoint — Strict",
  "description": "Brute-force protection on the login route.",
  "algorithm": "sliding_log",
  "limitCount": 5,
  "windowSeconds": 60,
  "identityType": "ip",
  "ipAddress": "0.0.0.0/0",
  "endpointPath": "POST /auth/login",
  "failureMode": "closed",
  "priority": 10
}
```

> **What is `ipAddress: "0.0.0.0/0"`?** The `INET` PostgreSQL type supports CIDR notation. `0.0.0.0/0` means "any IPv4 address" — a wildcard IP policy. This is the correct way to apply an IP-based policy to all clients, not just one specific IP.

#### Success Response — `201 Created`

```json
{
  "success": true,
  "data": {
    "policy": {
      "id": 7,
      "name": "Login Endpoint — Strict",
      "description": "Brute-force protection on the login route.",
      "algorithm": "sliding_log",
      "limitCount": 5,
      "windowSeconds": 60,
      "leakRatePerSecond": null,
      "identityType": "ip",
      "userId": null,
      "ipAddress": "0.0.0.0/0",
      "endpointPath": "POST /auth/login",
      "failureMode": "closed",
      "isActive": true,
      "priority": 10,
      "createdBy": 1,
      "createdAt": "2026-07-30T09:00:00.000Z",
      "updatedAt": "2026-07-30T09:00:00.000Z"
    }
  }
}
```

#### Error Responses

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Any field fails the validation rules above |
| `401` | `MISSING_CREDENTIALS` | No JWT |
| `403` | `INSUFFICIENT_ROLE` | JWT is valid but role is `developer` |

**Example validation error (algorithm + leakRatePerSecond mismatch):**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Policy creation failed validation.",
    "details": [
      {
        "field": "leakRatePerSecond",
        "message": "leakRatePerSecond may only be set when algorithm is 'leaky_bucket'. Received algorithm: 'fixed_window'."
      }
    ]
  }
}
```

---

### GET /policies

**Auth:** `(auth)`  
**Description:** List policies. Admins see all policies; developers see only policies where `user_id = their own id`.

#### Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `20` | Results per page (max 100) |
| `cursor` | string | none | Pagination cursor |
| `algorithm` | string | none | Filter by algorithm |
| `identityType` | string | none | Filter by identity type |
| `isActive` | boolean | `true` | `false` to include inactive policies |

```
GET /policies?algorithm=token_bucket&isActive=true
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "id": 7,
      "name": "Login Endpoint — Strict",
      "algorithm": "sliding_log",
      "limitCount": 5,
      "windowSeconds": 60,
      "identityType": "ip",
      "endpointPath": "POST /auth/login",
      "failureMode": "closed",
      "isActive": true,
      "priority": 10,
      "createdAt": "2026-07-30T09:00:00.000Z"
    }
  ],
  "meta": {
    "limit": 20,
    "nextCursor": null,
    "hasMore": false
  }
}
```

---

### GET /policies/:id

**Auth:** `(auth)`  
**Description:** Retrieve a single policy by ID. Developers can only access policies where `user_id` matches their own.

```
GET /policies/7
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": {
    "policy": {
      "id": 7,
      "name": "Login Endpoint — Strict",
      "description": "Brute-force protection on the login route.",
      "algorithm": "sliding_log",
      "limitCount": 5,
      "windowSeconds": 60,
      "leakRatePerSecond": null,
      "identityType": "ip",
      "userId": null,
      "ipAddress": "0.0.0.0/0",
      "endpointPath": "POST /auth/login",
      "failureMode": "closed",
      "isActive": true,
      "priority": 10,
      "createdBy": 1,
      "createdAt": "2026-07-30T09:00:00.000Z",
      "updatedAt": "2026-07-30T09:00:00.000Z"
    }
  }
}
```

#### Error Responses

| Status | Code | When |
|---|---|---|
| `401` | `MISSING_CREDENTIALS` | No JWT or API key |
| `403` | `FORBIDDEN` | Policy exists but belongs to another user (developer role) |
| `404` | `NOT_FOUND` | No policy with this `id` |

---

### PATCH /policies/:id

**Auth:** `(admin)`  
**Description:** Update one or more fields of an existing policy. Only the fields provided in the request body are updated — this is a partial update (PATCH semantics, not full replacement). Cross-column constraint validation is re-run against the merged state after the update.

> **Important — cache invalidation:** When a policy is updated, the in-process policy cache on each server instance holds the stale version for up to 30 seconds before expiring naturally. This is a known eventual-consistency window documented in `Architecture.md Section 3.3`. There is no immediate cache-bust mechanism in v1.

#### Request Body (all fields optional — only include what you are changing)

```json
PATCH /policies/7
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "limitCount": 3,
  "failureMode": "closed"
}
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": {
    "policy": {
      "id": 7,
      "name": "Login Endpoint — Strict",
      "limitCount": 3,
      "windowSeconds": 60,
      "failureMode": "closed",
      "updatedAt": "2026-07-30T09:45:00.000Z"
    }
  }
}
```

#### Error Responses

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Any updated field fails constraints |
| `401` | `MISSING_CREDENTIALS` | No JWT |
| `403` | `INSUFFICIENT_ROLE` | Role is `developer` |
| `404` | `NOT_FOUND` | No policy with this `id` |

---

### DELETE /policies/:id

**Auth:** `(admin)`  
**Description:** Deactivate a policy by setting `is_active = false`. The row is never physically deleted — it may be referenced by `audit_logs` rows. To permanently delete, an admin must first confirm in the admin dashboard (out of scope for v1 API).

```
DELETE /policies/7
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": {
    "message": "Policy 7 deactivated. Active requests using this policy will revert to the default policy within 30 seconds.",
    "deactivatedAt": "2026-07-30T10:00:00.000Z"
  }
}
```

#### Error Responses

| Status | Code | When |
|---|---|---|
| `401` | `MISSING_CREDENTIALS` | No JWT |
| `403` | `INSUFFICIENT_ROLE` | Role is `developer` |
| `404` | `NOT_FOUND` | No policy with this `id` |

---

## 9. Rate Limit Status Endpoints

These endpoints let a client or developer query their current rate limit state without making a business logic request.

---

### GET /rate-limit/status

**Auth:** `(auth)`  
**Description:** Check the current rate limit state for the authenticated user on a specific endpoint. Does not consume any tokens or increment any counters — read-only inspection.

#### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `endpoint` | string | ✓ | The endpoint to check, e.g., `GET /api/data` |

```
GET /rate-limit/status?endpoint=GET%20%2Fapi%2Fdata
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": {
    "endpoint": "GET /api/data",
    "policy": {
      "id": 4,
      "name": "Developer Default",
      "algorithm": "token_bucket",
      "limitCount": 1000,
      "windowSeconds": 60,
      "failureMode": "open"
    },
    "state": {
      "allowed": true,
      "remaining": 847,
      "resetAt": "2026-07-30T09:01:00.000Z",
      "algorithm": "token_bucket"
    }
  }
}
```

#### Error Responses

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | `endpoint` query param missing |
| `401` | `MISSING_CREDENTIALS` | No auth |

---

### GET /health

**Auth:** `(public)`  
**Description:** Health check endpoint. Returns the operational status of each system component. Used by Docker health checks, load balancers, and monitoring systems. Always returns `200` if the API server itself is running — component failures are reported inside the response body, not via HTTP status codes, so the load balancer does not remove the server from rotation on a Redis hiccup.

```
GET /health
```

#### Success Response — `200 OK` (all healthy)

```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "timestamp": "2026-07-30T09:00:00.000Z",
    "uptime": 3642,
    "components": {
      "api": {
        "status": "healthy"
      },
      "redis": {
        "status": "healthy",
        "latencyMs": 1
      },
      "postgres": {
        "status": "healthy",
        "latencyMs": 4
      }
    }
  }
}
```

#### Degraded Response — `200 OK` (Redis unreachable)

```json
{
  "success": true,
  "data": {
    "status": "degraded",
    "timestamp": "2026-07-30T09:00:00.000Z",
    "uptime": 3642,
    "components": {
      "api": {
        "status": "healthy"
      },
      "redis": {
        "status": "unhealthy",
        "error": "Connection refused",
        "latencyMs": null
      },
      "postgres": {
        "status": "healthy",
        "latencyMs": 4
      }
    }
  }
}
```

> **Why always 200?** If this endpoint returned `503` when Redis was down, a load balancer would stop sending traffic to the server — meaning the server's fail-open behaviour (passing requests through during Redis outage) would never activate, defeating its purpose. The degraded state is visible in the body for monitoring dashboards that can read the `status` field.

---

## 10. Admin & Metrics Endpoints

---

### GET /admin/users

**Auth:** `(admin)`  
**Description:** List all registered users. Includes `role`, `isActive`, and usage stats.

#### Query Parameters

| Parameter | Default | Description |
|---|---|---|
| `limit` | `20` | Max 100 |
| `cursor` | none | Pagination |
| `role` | none | Filter by `admin` or `developer` |
| `isActive` | `true` | Include inactive/suspended users |

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "email": "admin@example.com",
      "role": "admin",
      "isActive": true,
      "createdAt": "2026-07-29T08:00:00.000Z"
    },
    {
      "id": 2,
      "email": "vinay@example.com",
      "role": "developer",
      "isActive": true,
      "createdAt": "2026-07-30T09:00:00.000Z"
    }
  ],
  "meta": { "limit": 20, "nextCursor": null, "hasMore": false }
}
```

---

### PATCH /admin/users/:id

**Auth:** `(admin)`  
**Description:** Update a user's `role` or `isActive` status. Admins cannot update their own role (prevents accidental self-demotion).

#### Request Body (all optional)

| Field | Type | Validation |
|---|---|---|
| `role` | string | `"admin"` or `"developer"` — mirrors `CHECK (role IN ('admin', 'developer'))` |
| `isActive` | boolean | `true` (restore) or `false` (suspend) |

```json
PATCH /admin/users/2
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "role": "admin"
}
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": {
    "user": {
      "id": 2,
      "email": "vinay@example.com",
      "role": "admin",
      "isActive": true,
      "updatedAt": "2026-07-30T10:00:00.000Z"
    }
  }
}
```

#### Error Responses

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Invalid `role` value |
| `403` | `SELF_ROLE_CHANGE_FORBIDDEN` | Admin attempting to change their own role |
| `404` | `NOT_FOUND` | User does not exist |

---

### GET /admin/audit-logs

**Auth:** `(admin)`  
**Description:** Query rate limit audit log entries. Primary source for analytics dashboards.

#### Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Max 100 |
| `cursor` | string | none | Pagination |
| `userId` | integer | none | Filter by user |
| `endpoint` | string | none | Filter by endpoint (exact match) |
| `outcome` | string | none | `allowed`, `blocked`, or `fail_open` |
| `since` | ISO 8601 | none | Return events after this timestamp |
| `until` | ISO 8601 | none | Return events before this timestamp |
| `policyId` | integer | none | Filter by which policy matched |

```
GET /admin/audit-logs?outcome=blocked&since=2026-07-30T00:00:00.000Z&limit=20
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "id": 4821,
      "policyId": 7,
      "userId": null,
      "apiKeyPrefix": null,
      "ipAddress": "203.0.113.42",
      "endpoint": "POST /auth/login",
      "algorithm": "sliding_log",
      "outcome": "blocked",
      "limitCount": 5,
      "remaining": 0,
      "retryAfterSeconds": 47,
      "requestId": "req_9b3f1a7c",
      "createdAt": "2026-07-30T09:12:35.000Z"
    }
  ],
  "meta": { "limit": 20, "nextCursor": "eyJpZCI6NDgyMX0", "hasMore": true }
}
```

---

### GET /admin/stats

**Auth:** `(admin)`  
**Description:** Aggregate statistics for the dashboard — total requests, blocked requests, and top blocked IPs/endpoints for a time range.

#### Query Parameters

| Parameter | Default | Description |
|---|---|---|
| `since` | Last 24 hours | Start of window (ISO 8601) |
| `until` | Now | End of window (ISO 8601) |

#### Success Response — `200 OK`

```json
{
  "success": true,
  "data": {
    "period": {
      "since": "2026-07-29T09:00:00.000Z",
      "until": "2026-07-30T09:00:00.000Z"
    },
    "totals": {
      "requests": 142830,
      "blocked": 1247,
      "allowed": 141583,
      "failOpen": 12
    },
    "blockRate": 0.0087,
    "topBlockedEndpoints": [
      { "endpoint": "POST /auth/login", "blockedCount": 983 },
      { "endpoint": "POST /auth/register", "blockedCount": 264 }
    ],
    "topBlockedIps": [
      { "ipAddress": "203.0.113.42", "blockedCount": 421 },
      { "ipAddress": "198.51.100.7", "blockedCount": 187 }
    ]
  }
}
```

---

### GET /metrics

**Auth:** `(public)` — intended for internal Prometheus scraping, not exposed to the internet  
**Description:** Prometheus metrics endpoint. Returns metrics in the Prometheus text exposition format. Scraped by Prometheus every 15 seconds (configurable).

```
GET /metrics
```

#### Response — `200 OK` (plain text, not JSON)

```
# HELP rateshield_requests_total Total HTTP requests processed by the rate limiter
# TYPE rateshield_requests_total counter
rateshield_requests_total{endpoint="POST /auth/login",outcome="blocked"} 983
rateshield_requests_total{endpoint="POST /auth/login",outcome="allowed"} 4210
rateshield_requests_total{endpoint="GET /api/data",outcome="allowed"} 138593

# HELP rateshield_request_duration_seconds Request latency including rate limit check
# TYPE rateshield_request_duration_seconds histogram
rateshield_request_duration_seconds_bucket{le="0.005"} 98234
rateshield_request_duration_seconds_bucket{le="0.01"} 138102
rateshield_request_duration_seconds_bucket{le="0.025"} 142691
rateshield_request_duration_seconds_bucket{le="0.05"} 142820
rateshield_request_duration_seconds_bucket{le="+Inf"} 142830
rateshield_request_duration_seconds_sum 427.3
rateshield_request_duration_seconds_count 142830

# HELP rateshield_redis_operations_total Total Redis Lua script executions
# TYPE rateshield_redis_operations_total counter
rateshield_redis_operations_total{algorithm="token_bucket",result="ok"} 141583
rateshield_redis_operations_total{algorithm="sliding_log",result="ok"} 1247

# HELP rateshield_redis_errors_total Redis connection failures (triggers fail-open)
# TYPE rateshield_redis_errors_total counter
rateshield_redis_errors_total 12

# HELP rateshield_active_policies_total Number of active rate limit policies
# TYPE rateshield_active_policies_total gauge
rateshield_active_policies_total 8
```

> The `/metrics` endpoint should **not** be exposed to the public internet. In Docker Compose, Prometheus accesses it on the internal Docker network. In production, it should be behind an internal network boundary or require a shared secret header (not in scope for v1).

---

## 11. HTTP Status Code Reference

### The 429 Response — Rate Limited

A `429 Too Many Requests` is the primary output of a working rate limiter. It is returned when the Lua script determines the request exceeds the policy limit.

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1722345660
X-RateLimit-Algorithm: sliding_log
Retry-After: 47
X-Request-Id: req_9b3f1a7c
```

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. You have exceeded the rate limit for this endpoint.",
    "retryAfter": 47,
    "limit": 5,
    "windowSeconds": 60,
    "algorithm": "sliding_log",
    "policyName": "Login Endpoint — Strict"
  }
}
```

**What each 429 field means:**
- `retryAfter` — seconds until the client can retry (same value as the `Retry-After` header).
- `limit` — the limit that was exceeded.
- `windowSeconds` — the window size of the policy.
- `algorithm` — which algorithm made the decision.
- `policyName` — human-readable name of the matched policy (useful for debugging in development).

---

### The 503 Response — Fail-Closed Redis Failure

A `503 Service Unavailable` is returned when:
1. Redis is unreachable **AND**
2. The matched policy has `failure_mode = 'closed'`

This is intentionally different from a 429 — the request was not rate-limited, it was blocked due to an infrastructure failure. Clients should handle 503 differently: exponential backoff with jitter, not a fixed `Retry-After` wait.

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json
X-Request-Id: req_4d2e8f1b
```

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITER_UNAVAILABLE",
    "message": "The rate limiting service is temporarily unavailable. Please retry with exponential backoff.",
    "failureMode": "closed",
    "retryAfter": null
  }
}
```

**Why `retryAfter: null`?** Unlike a 429 (where we know exactly when the window resets), a 503 is a Redis connectivity issue of unknown duration. Telling the client to wait 47 seconds would be misleading — the outage could last 5 seconds or 5 minutes. `null` signals "we don't know; use exponential backoff."

**Contrast with fail-open:** If the matched policy has `failure_mode = 'open'` and Redis is down, the request passes through normally — the client sees a `200` and has no idea Redis was unreachable. This is by design (see `Redis.md Section 6`).

---

### Complete Status Code Table

| Status | Meaning | When RateShield Returns It |
|---|---|---|
| `200 OK` | Success | Successful GET, PATCH, DELETE, POST /auth/login, etc. |
| `201 Created` | Resource created | POST /auth/register, POST /api-keys, POST /policies |
| `400 Bad Request` | Client error in request | Validation failures, malformed JSON, missing required fields |
| `401 Unauthorized` | Auth failed | Missing/invalid token, revoked key, expired token |
| `403 Forbidden` | Auth passed but insufficient permission | Developer trying to create/modify policies; admin trying to change own role |
| `404 Not Found` | Resource does not exist | Policy, API key, or user not found by ID |
| `409 Conflict` | State conflict | Duplicate email registration, revoking an already-revoked key |
| `429 Too Many Requests` | Rate limit exceeded | Redis Lua script returned `allowed: false` |
| `503 Service Unavailable` | Infrastructure failure | Redis down + `failure_mode = 'closed'` |

---

## 12. Swagger / OpenAPI Generation

### Approach: `swagger-jsdoc` Inline Annotations

RateShield uses **`swagger-jsdoc`** to generate the OpenAPI 3.0 specification automatically from JSDoc comments written directly in the route files. The spec is served as an interactive UI via **`swagger-ui-express`** at:

```
http://localhost:3000/docs
```

### Why Inline Annotations, Not a Separate YAML File?

A hand-maintained `openapi.yaml` file is a second source of truth — it drifts from the implementation, and the drift is often only discovered when someone reads a stale doc months later.

`swagger-jsdoc` solves this by generating the spec from comments that live next to the route code:

```
backend/src/routes/auth.routes.js  ← route code
                                   ← @openapi comments live here too
```

When you change a route, the annotation is visible right next to it — you cannot change one without noticing the other. The generated spec is always derived from the annotations actually in the code, not a separate file.

### Example Annotation Pattern

```javascript
/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Authenticate with email and password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: vinay@example.com
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 example: mySecurePass123
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 *       429:
 *         description: Rate limit exceeded
 */
router.post('/login', authController.login)
```

This annotation pattern is repeated for every route. The `swagger-jsdoc` library scans all route files and assembles them into a single OpenAPI spec at startup.

### Swagger UI Access

The interactive docs are available at `/docs` in development. In production, this endpoint should be disabled or protected by HTTP Basic Auth — it exposes API shapes that could help an attacker.

```
Development:   http://localhost:3000/docs   (always enabled)
Production:    Disabled by default (SWAGGER_ENABLED=false env var)
```

### File Structure

```
backend/
  src/
    routes/
      auth.routes.js          ← @openapi annotations for auth endpoints
      api-keys.routes.js      ← @openapi annotations for API key endpoints
      policies.routes.js      ← @openapi annotations for policy endpoints
      admin.routes.js         ← @openapi annotations for admin endpoints
      health.routes.js        ← @openapi annotations for health/metrics
    config/
      swagger.config.js       ← swagger-jsdoc options: title, version, servers
    app.js                    ← mounts swagger-ui-express at /docs
```

---

## 13. API Versioning

### Decision: No Versioning for v1

RateShield v1 does **not** use URL versioning (no `/v1/` prefix) or header versioning (`API-Version: 1`).

**Why not?**

1. **The PRD has no v2 in scope.** Adding versioning infrastructure before there are two versions to support is premature complexity. The project is a learning and interview project — the overhead of a versioning scheme (separate routers, version negotiation, deprecation notices) would obscure the core concepts.

2. **Breaking changes are unlikely at this stage.** This is an internal API consumed by a single admin dashboard and load-test scripts. It is not a public API with third-party integrations to protect.

3. **Versioning is easy to add.** If RateShield is ever extended with a v2, adding `/v1/` and `/v2/` path prefixes to Express routers is a one-afternoon task. The cost of adding it now without needing it is higher than adding it later when it becomes necessary.

### The Upgrade Path (If Versioning Becomes Necessary)

When a breaking change is required, the approach would be:

```
/auth/login          → /v2/auth/login         (new behaviour)
/auth/login          → /v1/auth/login         (old behaviour, deprecated)
```

Both versions would coexist for a deprecation window (e.g., 6 months), then the v1 router would be removed. This is documented here so the decision is explicit — not accidental omission.

---

*Related documents:*
- [`docs/Architecture.md`](./Architecture.md) — Request flow, the 30s policy cache, rate limit headers origin
- [`docs/Database.md`](./Database.md) — Schema, validation constraints (the source of truth for all `CHECK` rules mirrored here)
- [`docs/Redis.md`](./Redis.md) — The Lua scripts that produce the `remaining`, `resetAt`, and `retryAfter` values returned in responses
- [`docs/Algorithms.md`](./Algorithms.md) — Each algorithm's behaviour, which determines what `remaining` and `resetAt` mean per algorithm
