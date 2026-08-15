# Testing Strategy & Quality Assurance Guide — RateShield

**Version:** 2.0  
**Date:** 2026-08-16  
**Author:** Vinay Anand Lodhi  
**Status:** Active Production Guide

---

## 1. Quality Assurance Architecture

RateShield utilizes a 4-tiered test pyramid to guarantee sub-millisecond precision, cryptographic security, and race-condition immunity under peak concurrency:

```
                      / \
                     /   \
                    / k6  \     Tier 4: Load & Stress Benchmarks (50-200 VUs)
                   /-------\
                  /  Race   \   Tier 3: Concurrency & Mutex Atomicity Tests
                 /-----------\
                / Integration \ Tier 2: Supertest HTTP Route End-to-End Tests
               /---------------\
              /    Unit Tests   \ Tier 1: Pure Algorithm & Mathematical Unit Tests
             /-------------------\
```

---

## 2. Test Suite Directory Structure

```
RateShield/
├── backend/
│   └── tests/
│       ├── unit/
│       │   ├── auth.service.test.js          # Password hashing, JWT signing & rotation
│       │   ├── fixedWindow.test.js           # Fixed Window counter & boundary TTL
│       │   ├── slidingWindow.test.js         # Weighted rolling overlap formula
│       │   ├── slidingLog.test.js            # Sorted set timestamp pruning & exact log
│       │   ├── tokenBucket.test.js           # Continuous token refill & burst accumulation
│       │   ├── leakyBucket.test.js           # Constant drain rate & queue depth
│       │   ├── policyCache.test.js           # Hierarchical deterministic policy resolution
│       │   └── distributedLock.test.js       # Redis mutex acquire, token release, retry
│       └── integration/
│           ├── health.routes.test.js         # /health multi-component live latency ping
│           ├── auth.routes.test.js           # /auth/* registration, login, token rotation
│           ├── rateLimit.routes.test.js      # Global rate limiter middleware & fail-open
│           ├── rateLimitStatus.routes.test.js# /rate-limit/status read-only quota inspection
│           ├── apiKey.routes.test.js         # /api-keys creation, X-API-Key auth, revocation
│           ├── metrics.routes.test.js        # /metrics Prometheus exposition validation
│           └── raceConditions.test.js        # 30 concurrent bursts & parallel worker locks
└── load-tests/
    ├── smoke.js                              # Baseline health & Prometheus latency checks
    ├── burst.js                              # 50 req/s rate limiter burst & 429 validation
    └── stress.js                             # 60 VU ramp-up saturation stress test
```

---

## 3. Running Automated Tests

### Run All Backend Unit & Integration Tests
```bash
cd backend
npm test
```

### Run Tests with Coverage Report
```bash
npm test -- --coverage
```

### Run Specific Test Suite
```bash
npx jest tests/integration/raceConditions.test.js
```

---

## 4. Key Testing Methodologies

### 1. Atomic Lua Script Testing
Rate limit algorithms run as isolated atomic Lua scripts on Redis. Tests verify:
- Accurate decrementing under heavy concurrency.
- Dynamic `Retry-After` calculation on 429 throttling.
- Clean key expiry without ghost counters.

### 2. Concurrency & Race Condition Verification
The `raceConditions.test.js` suite dispatches concurrent batches via `Promise.all`:
- **Burst Test**: 30 simultaneous requests fired within the same millisecond to ensure no request exceeds the defined capacity limit.
- **Distributed Mutex Test**: 5 concurrent worker threads competing for a single lock key, guaranteeing strictly 1 worker enters the critical section at any moment.

### 3. Fail-Open / Fail-Closed Resilience
Tests verify that when Redis or PostgreSQL is unreachable:
- Fail-open policies allow traffic through with `X-RateLimit-Fallback: true` and quieted logging.
- Fail-closed policies immediately return `503 RATE_LIMITER_UNAVAILABLE`.

---

## 5. Continuous Integration (CI)

All 15 test suites are automatically executed in GitHub Actions (`.github/workflows/ci.yml`) against live health-checked PostgreSQL 16 and Redis 7 containers on every push and pull request.
