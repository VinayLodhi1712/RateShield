# Testing Strategy — RateShield

**Version:** 1.0  
**Date:** 2026-08-14  
**Author:** Vinay Anand Lodhi  
**Status:** Active

---

## 1. Overview

RateShield uses a multi-layered testing strategy to guarantee reliability, security, and low latency.

- **Unit Tests**: Test isolated business logic (token generation, hashing, algorithm calculations).
- **Integration Tests**: Test Express routes end-to-end using `supertest` with mocked or live dependencies.
- **Load & Performance Tests**: Verify throughput (1,000 req/s) and latency targets (p99 < 50ms) using `k6` (Milestone 18).

---

## 2. Test Structure

```
backend/
  tests/
    unit/
      auth.service.test.js      # Password hashing, JWT signing/verifying
      requestId.test.js         # Request ID generator
    integration/
      auth.routes.test.js       # Register, login, refresh, logout endpoints
      health.routes.test.js     # Health check endpoint
```

---

## 3. Running Tests

```bash
# Run all test suites
npm test

# Run tests in watch mode during development
npm test -- --watch

# Run a specific test file
npx jest tests/integration/auth.routes.test.js
```

---

## 4. Key Testing Patterns

1. **Supertest on `app.js`**: We test the Express app directly without binding to a physical network port.
2. **Deterministic Mocking**: Centralized `config` and database models are mocked in isolation when live Postgres/Redis are not present.
3. **Security Testing**: Verify that malformed tokens, expired tokens, and credential mismatch return the exact error envelopes specified in `docs/API.md`.
