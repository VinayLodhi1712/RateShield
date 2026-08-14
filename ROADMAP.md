# ROADMAP

Milestones are implemented one at a time. Do not start a new milestone until the previous one is implemented, tested, and understood.

## Phase 1 — Fast-Track MVP

- [x] **Milestone 1 — Project Initialization**
- [x] **Milestone 2 — Folder Structure**
- [x] **Milestone 3 — Express Server**
  Base app, health check route
- [x] **Milestone 4 — Configuration**
  Centralized config module, env validation
- [x] **Milestone 5 — Logger**
  Winston setup, log levels, HTTP request logging middleware
- [x] **Milestone 6 — Error Handling**
  Custom error classes, centralized error middleware
- [x] **Milestone 7 — Authentication (JWT only)**
  Register, login, refresh — JWT + refresh tokens only; API keys deferred to Phase 2
- [ ] **Milestone 8 — Redis Integration**
  ioredis client, connection wrapper, health check update
- [ ] **Milestone 9 — Fixed Window Rate Limiter**
  Lua script, middleware wiring, 429 response shape
- [ ] **Milestone 10 — Policies Table + Seed**
  Minimal PostgreSQL schema for policies, one default policy seed script
- [ ] **Milestone 11 — Rate Limit Status Endpoint**
  GET /rate-limit/status — current state for authenticated user
- [ ] **Milestone 12 — Docker (MVP)**
  Dockerfile + docker-compose: backend + Redis + PostgreSQL only

## Phase 2 — Post-MVP

> Complete Phase 1 first. Nothing here blocks a working demo.

- [ ] **API Keys** — create, list, revoke; API key auth on rate limiter
- [ ] **Sliding Window algorithm**
- [ ] **Sliding Log algorithm**
- [ ] **Token Bucket algorithm**
- [ ] **Leaky Bucket algorithm**
- [ ] **Distributed Locking** — Lua atomicity hardening, race condition tests
- [ ] **Metrics** — Prometheus client, prom-client instrumentation
- [ ] **Prometheus** — scrape config, docker-compose integration
- [ ] **Grafana** — dashboards, provisioning
- [ ] **Load Testing** — k6 scripts, performance report
- [ ] **CI/CD** — GitHub Actions: lint, test, build on PR
- [ ] **Deployment Guide** — docs/Deployment.md, cloud/VPS deploy
- [ ] **Documentation Polish** — finalize all docs, architecture diagrams
- [ ] **Performance Optimization** — profiling, bottleneck fixes
- [ ] **Resume Polish** — README, screenshots, demo GIF

## Stretch Goal

- [ ] Extract rate-limiter core into a standalone npm package (see PRD)