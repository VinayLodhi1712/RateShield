# RateShield — Complete Feature Verification & Testing Guide

This guide walks you through verifying **every single feature** built into RateShield. It includes the exact commands to run, what to click in the UI, and the **exact expected results**.

---

## 📋 Table of Contents
1. [Prerequisites & Booting the Stack](#1-prerequisites--booting-the-stack)
2. [Feature 1: Multi-Component Health Ping (`GET /health`)](#feature-1-multi-component-health-ping)
3. [Feature 2: JWT Authentication & Token Rotation (`POST /auth/*`)](#feature-2-jwt-authentication--token-rotation)
4. [Feature 3: API Key Management & `X-API-Key` Auth (`/api-keys`)](#feature-3-api-key-management--x-api-key-auth)
5. [Feature 4: 5 Rate Limiting Algorithms & 429 Throttling](#feature-4-5-rate-limiting-algorithms--429-throttling)
6. [Feature 5: Next.js Interactive Dashboard & Burst Generator](#feature-5-nextjs-interactive-dashboard)
7. [Feature 6: Prometheus Metrics Scraping (`GET /metrics`)](#feature-6-prometheus-metrics-scraping)
8. [Feature 7: Pre-Provisioned Grafana Telemetry Dashboard](#feature-7-pre-provisioned-grafana-telemetry-dashboard)
9. [Feature 8: Automated k6 Performance & Load Testing](#feature-8-automated-k6-performance--load-testing)
10. [Feature 9: Fail-Open Resilience (Simulated Outage Test)](#feature-9-fail-open-resilience-simulated-outage-test)
11. [Feature 10: Complete Automated Test Suite (100% Pass)](#feature-10-complete-automated-test-suite)

---

## 1. Prerequisites & Booting the Stack

You can run RateShield in **Docker Compose (recommended)** or **Bare-Metal Node.js**.

### Option A: Docker Compose (All 5 Services)
From the project root:
```bash
# 1. Start Postgres, Redis, API, Prometheus, and Grafana in background
docker compose up -d --build

# 2. Seed database schema and initial policies
docker compose exec api npm run db:seed
```

### Option B: Bare-Metal (Local Dev)
```bash
# Terminal 1: Backend
cd backend
npm run db:seed
npm run dev

# Terminal 2: Frontend Dashboard
cd frontend
npm run dev
```

---

## Feature 1: Multi-Component Health Ping

Tests live multi-service latency checks against Redis and PostgreSQL.

### Command:
```bash
curl -i http://localhost:3000/health
```

### Expected Output:
- **HTTP Status:** `200 OK`
- **Response Headers:** `X-Request-Id: req_...`, `X-RateLimit-Limit: 100`
- **Response Body:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "uptime": 45,
    "components": {
      "api": { "status": "healthy" },
      "redis": { "status": "healthy", "latencyMs": 1 },
      "postgres": { "status": "healthy", "latencyMs": 2 }
    }
  }
}
```

---

## Feature 2: JWT Authentication & Token Rotation

Tests user registration, bcrypt password hashing, JWT signing, and single-use refresh token rotation.

### 2.1 Register New Developer Account
```bash
curl -i -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@rateshield.io","password":"SecurePassword123!"}'
```
- **Expected Status:** `201 Created`
- **Expected Result:** Returns user object `{ id, email: "demo@rateshield.io", role: "developer" }`.

### 2.2 Login & Obtain Tokens
```bash
curl -i -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@rateshield.io","password":"SecurePassword123!"}'
```
- **Expected Status:** `200 OK`
- **Expected Result:** Returns `accessToken` (15m expiration) and `refreshToken` (7-day single-use token).

### 2.3 Rotate Refresh Token
Save your `refreshToken` from step 2.2 and run:
```bash
curl -i -X POST http://localhost:3000/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"YOUR_REFRESH_TOKEN_HERE"}'
```
- **Expected Status:** `200 OK`
- **Expected Result:** Issues a **new** access token and a **new** rotated refresh token. The previous refresh token is immediately revoked. Replaying the old token returns `401 TOKEN_REVOKED`.

---

## Feature 3: API Key Management & `X-API-Key` Auth

Tests cryptographically secure key generation, SHA-256 hash storage, and header authentication.

### 3.1 Generate an API Key
Save your `accessToken` from login and run:
```bash
curl -i -X POST http://localhost:3000/api-keys \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Production Microservice"}'
```
- **Expected Status:** `201 Created`
- **Expected Result:**
```json
{
  "success": true,
  "data": {
    "apiKey": {
      "id": 1,
      "name": "Production Microservice",
      "prefix": "rs_a1b2c",
      "key": "rs_a1b2c3d4e5f6...35_chars_long",
      "isActive": true
    },
    "warning": "Save this key now — it will not be shown again."
  }
}
```

### 3.2 List Active API Keys (Metadata Only)
```bash
curl -i -X GET http://localhost:3000/api-keys \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```
- **Expected Status:** `200 OK`
- **Expected Result:** Lists keys with `name`, `prefix`, and `lastUsedAt`. The raw secret key is **never** exposed in listings.

### 3.3 Authenticate Using `X-API-Key` Header
Use the raw key from step 3.1:
```bash
curl -i http://localhost:3000/health \
  -H "X-API-Key: YOUR_RAW_RS_KEY"
```
- **Expected Status:** `200 OK`
- **Expected Result:** Authenticates with identity `apikey:rs_...` and increments rate limiting quota independently of IP.

### 3.4 Revoke API Key
```bash
curl -i -X DELETE http://localhost:3000/api-keys/1 \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```
- **Expected Status:** `200 OK`
- **Expected Result:** Soft-revokes key (`isActive: false`). Subsequent requests with that key instantly fall back to anonymous IP identity.

---

## Feature 4: 5 Rate Limiting Algorithms & 429 Throttling

Tests atomic Lua rate limiter enforcement and HTTP 429 responses.

### 4.1 Trigger 429 Throttling on Strict Endpoint
The `POST /auth/login` endpoint has a strict limit of **5 requests per 60 seconds**.
Run this loop in bash or PowerShell to fire 6 requests:

**Bash / Linux / macOS:**
```bash
for i in {1..6}; do
  curl -s -o /dev/null -w "Request $i: HTTP %{http_code}\n" -X POST http://localhost:3000/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"wrong@email.com","password":"wrong"}'
done
```

**PowerShell (Windows):**
```powershell
1..6 | ForEach-Object {
  $res = Invoke-WebRequest -Uri "http://localhost:3000/auth/login" -Method Post -Body '{"email":"wrong@email.com","password":"wrong"}' -ContentType "application/json" -SkipHttpErrorCheck
  Write-Host "Request $_: HTTP $($res.StatusCode)"
}
```

### Expected Output:
```
Request 1: HTTP 401 (or 200)
Request 2: HTTP 401
Request 3: HTTP 401
Request 4: HTTP 401
Request 5: HTTP 401
Request 6: HTTP 429 (Too Many Requests!)
```

### Inspect the 429 Response Headers & Body:
```bash
curl -i -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"wrong@email.com","password":"wrong"}'
```
- **Expected Headers:**
  - `HTTP/1.1 429 Too Many Requests`
  - `Retry-After: 58`
  - `X-RateLimit-Limit: 5`
  - `X-RateLimit-Remaining: 0`
  - `X-RateLimit-Algorithm: fixed_window` (or policy algorithm)
- **Expected Body:**
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. You have exceeded the rate limit for this endpoint.",
    "retryAfter": 58,
    "limit": 5,
    "windowSeconds": 60,
    "policyName": "Strict Login Policy"
  }
}
```

### 4.2 Inspect Rate Limit Status (Read-Only)
```bash
curl -i "http://localhost:3000/rate-limit/status?endpoint=GET%20/health" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```
- **Expected Status:** `200 OK`
- **Expected Result:** Returns current capacity, remaining quota, reset ISO timestamp, and active algorithm without consuming quota tokens.

---

## Feature 5: Next.js Interactive Dashboard

Tests the real-time visual dashboard and traffic burst generator.

1. Open your browser and navigate to: **`http://localhost:3000`**
2. **Top Header:**
   - Verify the green pulse badge: **"All Systems Operational"**.
   - Check real-time latency badges for API, Redis, and PostgreSQL.
3. **Live Rate Limit SVG Gauge:**
   - View the animated circular ring displaying your live remaining tokens.
   - The ring smoothly transitions from **Cyan** ($> 50\%$) to **Amber** ($20\text{--}50\%$) to **Rose Red** ($< 20\%$).
4. **Traffic Generator:**
   - Click **"Burst 5 Reqs"** or **"Burst 15 Reqs"**.
   - Watch the gauge decrement in real-time.
   - Watch the **Live Request Telemetry Table** populate with status `200` (green) and `429` (pulsating red).
5. **Interactive Continuous Stream:**
   - Click **"Start Stream"** to simulate continuous $2\text{ req/s}$ client traffic.
   - Click **"Stop Stream"** to halt.
6. **API Keys Management Modal:**
   - Click **"API Keys"** in the top right.
   - Enter a key name (e.g. `Test Key`) and click **"Generate Key"**.
   - Click the **Copy** button to copy the raw `rs_...` key.
   - Click **"Revoke"** to deactivate it live.

---

## Feature 6: Prometheus Metrics Scraping

Tests the Prometheus metrics exposition endpoint.

### Command:
```bash
curl -i http://localhost:3000/metrics
```

### Expected Output:
- **HTTP Status:** `200 OK`
- **Content-Type:** `text/plain; version=0.0.4`
- **Expected Metrics in output:**
  - `rateshield_http_requests_total{method="GET",route="/health",status_code="200"}`
  - `rateshield_http_request_duration_seconds_bucket{le="0.05",...}`
  - `rateshield_ratelimit_decisions_total{action="allowed",algorithm="fixed_window",...}`
  - `rateshield_process_cpu_user_seconds_total`
  - `rateshield_nodejs_heap_size_used_bytes`

### Prometheus Web UI (Docker):
Open **`http://localhost:9090`** in your browser:
- In the query bar, type: `rateshield_http_requests_total` and click **Execute**.
- Switch to the **Graph** tab to view the live request rate graph.

---

## Feature 7: Pre-Provisioned Grafana Telemetry Dashboard

Tests the auto-provisioned Grafana monitoring visualizer.

1. Open your browser and navigate to: **`http://localhost:3001`**
2. Login with credentials:
   - **Username:** `admin`
   - **Password:** `admin`
3. Click **Dashboards** $\rightarrow$ **RateShield** $\rightarrow$ **RateShield Telemetry Dashboard**.
4. **Inspect Dashboard Panels:**
   - **HTTP Throughput (req/s by Status)**: Real-time line chart of incoming traffic.
   - **Request Latency Percentiles (p95 / p99)**: Sub-millisecond latency curves.
   - **Rate Limit Decisions (Allowed vs Blocked)**: Stacked bar chart by algorithm.
   - **Blocked Requests (429s in last 1m)**: Big red indicator when throttling triggers.
   - **Redis Failures & Downtime Events**: Alerts on connection drops.

---

## Feature 8: Automated k6 Performance & Load Testing

Tests high-throughput concurrent load and latency saturation.

### 8.1 Smoke Test (Baseline Sanity)
```bash
k6 run load-tests/smoke.js
```
- **Expected Result:** All assertions pass, 95th percentile latency $< 100\text{ms}$, error rate $= 0\%$.

### 8.2 Burst Test (Rate Limit Atomicity)
```bash
k6 run load-tests/burst.js
```
- **Expected Result:** 50 requests/sec burst successfully throttles without dropping connections; headers `X-RateLimit-*` and `Retry-After` verified on all requests.

### 8.3 Stress Test (60 Concurrent Virtual Users)
```bash
k6 run load-tests/stress.js
```
- **Expected Result:** Ramps to 60 VUs; system remains stable with P99 latency $< 300\text{ms}$.

---

## Feature 9: Fail-Open Resilience (Simulated Outage Test)

Tests that RateShield never blocks upstream application traffic when Redis is down.

1. **Simulate Redis Outage:**
   ```bash
   docker stop rateshield-redis
   ```
2. **Send Request to Protected Route:**
   ```bash
   curl -i http://localhost:3000/health
   ```
3. **Expected Result:**
   - **HTTP Status:** `200 OK` (Application does **NOT** crash or block the user).
   - **Header Present:** `X-RateLimit-Fallback: true`.
   - **Backend Logs:** Displays a single quiet warning: `[RateLimit] Redis unavailable, failing open`.
4. **Restore Redis:**
   ```bash
   docker start rateshield-redis
   ```
5. Subsequent requests resume atomic Redis rate limiting automatically.

---

## Feature 10: Complete Automated Test Suite

Runs the entire 15 test suites spanning unit, integration, and concurrency tests.

### Command:
```bash
cd backend
npm test
```

### Expected Output:
```
Test Suites: 15 passed, 15 total
Tests:       59 passed, 59 total
Snapshots:   0 total
Time:        ~5.5 s
Ran all test suites.
```

---

## 🎯 Verification Checklist Summary

| Feature Area | Verification Status |
|---|---|
| **Multi-Component Health Ping** | `GET /health` returns live Redis & Postgres latencies |
| **JWT Authentication** | Register, Login, Refresh rotation, and Logout working |
| **API Keys Management** | `rs_...` generation, SHA-256 storage, and `X-API-Key` auth working |
| **All 5 Algorithms** | Fixed Window, Sliding Window, Sliding Log, Token Bucket, Leaky Bucket passing |
| **429 Throttling & Headers** | `Retry-After`, `X-RateLimit-*` verified under burst load |
| **Next.js Dashboard** | Live SVG Gauge, burst generator, and telemetry stream working |
| **Prometheus Exporter** | `GET /metrics` exporting throughput, latency histograms, and process stats |
| **Grafana Dashboards** | Pre-provisioned panels loaded on `http://localhost:3001` |
| **k6 Performance Tests** | Smoke, Burst, and Stress scenarios passing |
| **Fail-Open Resilience** | Graceful fallback with `X-RateLimit-Fallback: true` during outages |
| **CI/CD Pipeline** | GitHub Actions passing 59 tests on push/pull requests |
