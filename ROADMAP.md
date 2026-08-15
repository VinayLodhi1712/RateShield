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
- [x] **Milestone 8 — Redis Integration**
  ioredis client, connection wrapper, health check update
- [x] **Milestone 9 — Fixed Window Rate Limiter**
  Lua script, middleware wiring, 429 response shape
- [x] **Milestone 10 — Policies Table + Seed**
  Minimal PostgreSQL schema for policies, one default policy seed script
- [x] **Milestone 11 — Rate Limit Status Endpoint**
  GET /rate-limit/status — current state for authenticated user
- [x] **Milestone 12 — Docker (MVP)**
  Dockerfile + docker-compose: backend + Redis + PostgreSQL only

## Phase 2 — Post-MVP

> Complete Phase 1 first. Nothing here blocks a working demo.

- [x] **API Keys** — create, list, revoke; API key auth on rate limiter
- [x] **Sliding Window algorithm**
- [x] **Sliding Log algorithm**
- [x] **Token Bucket algorithm**
- [x] **Leaky Bucket algorithm**
- [x] **Distributed Locking** — Lua atomicity hardening, race condition tests
- [x] **Metrics** — Prometheus client, prom-client instrumentation
- [x] **Prometheus** — scrape config, docker-compose integration
- [x] **Grafana** — dashboards, provisioning
- [x] **Load Testing** — k6 scripts, performance report
- [x] **CI/CD** — GitHub Actions: lint, test, build on PR
- [x] **Deployment Guide** — docs/Deployment.md, cloud/VPS deploy
- [x] **Documentation Polish** — finalize all docs, architecture diagrams
- [x] **Performance Optimization** — profiling, bottleneck fixes
- [x] **Resume Polish** — README, screenshots, demo GIF

## Phase 3 — Standalone Package & Production Cloud Deployment

- [ ] **Milestone 1 — Standalone NPM Package Architecture** (`@rateshield/core`)
  - Extract Redis Lua limiters, distributed mutex, and Express/Fastify middleware into an independent, zero-dependency engine package
- [ ] **Milestone 2 — NPM Package Distribution & TypeScript Typing**
  - Add TypeScript declarations (`.d.ts`), Rollup/esbuild bundle pipeline, and local/npm publishing configs
- [ ] **Milestone 3 — Production Cloud Deployment (Live URL)**
  - Deploy RateShield API & Next.js dashboard to AWS ECS / Render / Fly.io with managed PostgreSQL and Redis