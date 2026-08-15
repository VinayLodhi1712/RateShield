<div align="center">

# 🛡️ RateShield
### High-Performance Distributed Rate Limiter & Token Management Platform

[![CI Pipeline](https://github.com/VinayLodhi1712/RateShield/actions/workflows/ci.yml/badge.svg)](https://github.com/VinayLodhi1712/RateShield/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Next.js-16_App_Router-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7_Lua_Atomic-DC382D?logo=redis&logoColor=white)](https://redis.io)
[![Prometheus](https://img.shields.io/badge/Prometheus-Metrics-E6522C?logo=prometheus&logoColor=white)](https://prometheus.io)
[![Grafana](https://img.shields.io/badge/Grafana-Dashboards-F46800?logo=grafana&logoColor=white)](https://grafana.com)
[![Docker](https://img.shields.io/badge/Docker-Compose_5_Services-2496ED?logo=docker&logoColor=white)](https://www.docker.com)
[![Tests](https://img.shields.io/badge/Tests-59_Passed_100%25-brightgreen?logo=jest&logoColor=white)](./docs/Testing.md)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A production-grade, distributed rate-limiting platform engineered for high-throughput, low-latency microservices with zero race conditions, full observability, and fail-open resilience.**

[Key Features](#-key-features) • [Architecture](#-architecture) • [Algorithm Matrix](#-algorithm-comparison-matrix) • [Quick Start](#-quick-start) • [Documentation](#-deep-dive-documentation)

</div>

---

## 🌟 Why RateShield?

Most rate limiter tutorials rely on single-node in-memory variables that collapse under horizontal scaling. **RateShield** is engineered for real-world distributed architectures:
- **Zero Race Conditions**: Atomic Lua scripts executed via `EVALSHA` in Redis eliminate check-then-act concurrency bugs.
- **Fail-Open Resilience**: Gracefully permits upstream traffic during Redis or PostgreSQL outages without cascading service degradation.
- **Sub-Millisecond Overhead**: Precompiled SHA-1 Lua hashes and microsecond policy caching provide $O(1)$ decision latency.
- **5 Rate Limiting Algorithms**: Select the ideal algorithm per route, user tier, or API key.
- **Full-Stack Observability**: Built-in Next.js live telemetry dashboard, Prometheus metrics exporter, auto-provisioned Grafana panels, and automated k6 load testing suites.

---

## 🚀 Key Features

- **5 Core Rate Limiting Algorithms**:
  - **Fixed Window**: Ultra-low memory counter with boundary TTL expiration.
  - **Sliding Window**: Weighted previous-window overlap counter eliminating $2\times$ boundary bursts.
  - **Sliding Log**: Exact rolling-window timestamp log in Redis Sorted Sets ($0\%$ burst tolerance for security-critical endpoints like `/auth/login`).
  - **Token Bucket**: Continuous fractional token refilling for bursty developer APIs.
  - **Leaky Bucket**: Constant-rate queue drain smoothing spiky workloads into predictable throughput.
- **Authentication & Key Management**:
  - **JWT Token Rotation**: Secure single-use refresh token exchange with replay-attack revocation.
  - **API Key Management**: Cryptographic SHA-256 hashed keys (`rs_...`) with instant revocation and prefix-based rate limiting (`apikey:first8chars`).
- **Distributed Locking**: Redlock-style mutex with atomic token-checked release Lua scripts for safe concurrency across multi-instance clusters.
- **Full Observability Stack**:
  - Prometheus `/metrics` scraping with HTTP throughput, P95/P99 latency histograms, and throttle counters.
  - Pre-provisioned Grafana dashboard (`http://localhost:3001`).
  - Modern Next.js 16 App Router dark-mode dashboard with live SVG rate gauge, burst generator, and telemetry stream.
- **Enterprise Testing & CI/CD**:
  - 59 automated unit, integration, and race condition tests running in GitHub Actions with live containerized PostgreSQL and Redis.
  - k6 performance suites for smoke, burst, and stress load testing.

---

## 🏛️ System Architecture

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 Internet / Clients                     │
                  └──────────────────────────┬─────────────────────────────┘
                                             │
                                   HTTPS / TLS (Port 443)
                                             │
                                             ▼
                  ┌────────────────────────────────────────────────────────┐
                  │           Nginx / Cloud Load Balancer (ALB)            │
                  └───────┬──────────────────────────────┬─────────────────┘
                          │                              │
                    Port 3000                      Port 3000
                          │                              │
                          ▼                              ▼
             ┌─────────────────────────┐    ┌─────────────────────────┐
             │   RateShield Node (1)   │    │   RateShield Node (N)   │
             │  - Stage 1 Auth (JWT/Key) │    │  - Stage 1 Auth (JWT/Key) │
             │  - Stage 2 Lua Limiters │    │  - Stage 2 Lua Limiters │
             │  - Next.js UI / Metrics │    │  - Next.js UI / Metrics │
             └────────────┬────────────┘    └────────────┬────────────┘
                          │                              │
          ┌───────────────┴──────────────────────────────┴───────────────┐
          │                                                              │
          ▼                                                              ▼
┌───────────────────────────────┐              ┌───────────────────────────────┐
│     Redis (Cluster / Single)  │              │    PostgreSQL (Durable Store) │
│ - 5 Atomic Lua Rate Limiters  │              │ - Users, Policies, API Keys   │
│ - Sub-millisecond $O(1)$ State│              │ - Refresh Token Rotation      │
└───────────────┬───────────────┘              └───────────────────────────────┘
                │
                ▼
┌───────────────────────────────┐              ┌───────────────────────────────┐
│     Prometheus (Port 9090)    │ ───────────► │      Grafana (Port 3001)      │
│ - 5s Metric Scraping (/metrics│              │ - Auto-provisioned Dashboards │
└───────────────────────────────┘              └───────────────────────────────┘
```

---

## 📊 Algorithm Comparison Matrix

| Algorithm | Redis Structure | Primary Strength | Weakness | Ideal Use Case |
|---|---|---|---|---|
| **Fixed Window** | String counter + TTL | $O(1)$ CPU & memory, ultra-fast | $2\times$ boundary burst | Broad API usage budgets (e.g. 10k req/day) |
| **Sliding Window** | 2 String counters | Solves boundary burst with low memory | Small approximation error | General per-user request quotas |
| **Sliding Log** | Sorted Set (timestamps) | Exact rolling window ($100\%$ precision) | Memory scales with limit size | Low-volume security endpoints (`/auth/login`) |
| **Token Bucket** | Hash (`tokens`, `last_refill`)| Accommodates natural bursts with steady average | Complex state tracking | High-traffic developer read APIs |
| **Leaky Bucket** | Hash (`queue`, `last_leak`) | Smooths traffic into constant processing rate | Drops excess burst traffic | Heavy compute & background worker tasks |

---

## ⚡ Quick Start

### 1. One-Click Launch (Docker Compose)
Launch the entire 5-container production topology with a single command:

```bash
# 1. Clone the repository
git clone https://github.com/VinayLodhi1712/RateShield.git
cd RateShield

# 2. Build and start all services (Postgres, Redis, API, Prometheus, Grafana)
docker compose up -d --build

# 3. Seed database schema and initial admin policies
docker compose exec api npm run db:seed
```

### Access Ports & Services
- **RateShield Dashboard & API**: [`http://localhost:3000`](http://localhost:3000)
- **Prometheus Metrics Explorer**: [`http://localhost:9090`](http://localhost:9090)
- **Grafana Live Telemetry**: [`http://localhost:3001`](http://localhost:3001) *(Login: `admin` / `admin`)*
- **PostgreSQL**: `localhost:5433`
- **Redis**: `localhost:6379`

---

### 2. Bare-Metal Local Development

```bash
# Terminal 1: Backend
cd backend
npm install
npm run db:seed
npm run dev

# Terminal 2: Frontend Dashboard
cd ../frontend
npm install
npm run dev
```

---

## 🧪 Testing & Quality Assurance

RateShield includes a comprehensive 4-tiered test suite with **59 automated tests**:

```bash
# Run all unit and integration test suites
cd backend
npm test

# Run tests with coverage
npm test -- --coverage

# Run k6 performance benchmarks
k6 run load-tests/smoke.js
k6 run load-tests/burst.js
k6 run load-tests/stress.js
```

---

## 📚 Deep-Dive Documentation

Every architectural design decision, algorithm specification, and security tradeoff is documented in depth:

| Document | Description |
|---|---|
| **[PRD.md](./docs/PRD.md)** | Product requirements, performance targets, and non-goals |
| **[Architecture.md](./docs/Architecture.md)** | System components, request flow pipeline, and distributed locking |
| **[Algorithms.md](./docs/Algorithms.md)** | Mathematical formulas, pseudocode, and worked examples for all 5 limiters |
| **[Database.md](./docs/Database.md)** | PostgreSQL schema, indexing strategies, and deterministic policy hierarchy |
| **[Redis.md](./docs/Redis.md)** | Key design conventions, TTL policies, Lua scripts, and memory benchmarks |
| **[API.md](./docs/API.md)** | Complete REST API specification, standard error envelopes, and rate limit headers |
| **[Deployment.md](./docs/Deployment.md)** | Docker Compose topology, Nginx SSL reverse proxy, and cloud auto-scaling (HPA) |
| **[Testing.md](./docs/Testing.md)** | 4-tiered QA pyramid, race condition verification, and k6 load scenarios |

---

## 👤 Author

**Vinay Anand Lodhi**  
*Full Stack & Distributed Systems Engineer*  
GitHub: [@VinayLodhi1712](https://github.com/VinayLodhi1712)