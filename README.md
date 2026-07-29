# RateShield

**A production-style distributed rate limiting platform, built to learn — and demonstrate — advanced backend engineering.**

RateShield protects APIs from abuse using multiple rate limiting algorithms (Fixed Window, Sliding Window, Sliding Log, Token Bucket, Leaky Bucket), coordinated across multiple server instances via Redis. It includes authentication, per-endpoint/per-user/per-IP policies, monitoring (Prometheus + Grafana), load testing (k6), and Docker-based deployment.

This project was built feature-by-feature, with every architectural decision documented and understood — not generated in one shot. See [`docs/`](./docs) for the full reasoning behind each choice.

---

## Why this project exists

Most rate limiter tutorials show a single in-memory counter that breaks the moment you run more than one server instance. RateShield is an attempt to build the real thing: a limiter that stays correct and fast when requests are hitting multiple app servers at once, coordinated through Redis with atomic operations.

The goal was to learn, hands-on:
- Distributed systems coordination (why a single Redis instance, atomicity, race conditions)
- Caching and TTL-based data expiry
- Rate limiting algorithm trade-offs (accuracy vs memory vs burst tolerance)
- Production folder structure and clean architecture (SOLID, thin controllers, service layer)
- Docker-based local + deployable environments
- Observability (Prometheus metrics, Grafana dashboards)
- Load testing and measuring real throughput (k6)

## Features

- **Multiple rate limiting algorithms** — Fixed Window, Sliding Window, Sliding Log, Token Bucket, Leaky Bucket, selectable per endpoint/policy
- **Distributed & atomic** — Redis-backed counters using atomic Lua scripts / MULTI, safe across concurrent instances
- **Configurable policies** — per-user, per-IP, per-endpoint limits
- **Authentication** — JWT-based login, roles, API keys
- **Admin APIs** — manage policies and inspect current limiter state
- **Monitoring** — Prometheus metrics + Grafana dashboards, health checks, structured logging (Winston)
- **API documentation** — Swagger/OpenAPI
- **Containerized** — Docker Compose for local dev (API + Redis + Postgres + Prometheus + Grafana)
- **Tested** — Jest + Supertest for unit/integration, k6 for load testing

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Database | PostgreSQL |
| Cache / Coordination | Redis |
| Auth | JWT |
| API Docs | Swagger |
| Monitoring | Prometheus, Grafana |
| Containerization | Docker, Docker Compose |
| Testing | Jest, Supertest, k6 |
| Logging | Winston |

## Project Structure

```
RateShield/
├── docs/              # PRD, architecture, API spec, DB schema, Redis design, algorithms, deployment, testing
├── backend/           # Express API — controllers, services, middleware, config
├── frontend/          # Minimal admin dashboard (optional, kept simple by design)
├── docker/            # Dockerfiles, docker-compose.yml, service configs
├── monitoring/        # Prometheus config, Grafana dashboards/provisioning
├── load-testing/      # k6 scripts and performance reports
└── README.md
```

See [`docs/Architecture.md`](./docs/Architecture.md) for how these pieces fit together, and [`ROADMAP.md`](./ROADMAP.md) for the milestone-by-milestone build order.

## Getting Started

> Full setup instructions will be added as the backend is scaffolded in Milestone 1–3.

```bash
git clone <repo-url>
cd RateShield
docker compose -f docker/docker-compose.yml up -d   # starts Redis, Postgres, Prometheus, Grafana
cd backend
npm install
npm run dev
```

## Documentation

| Document | Purpose |
|---|---|
| [PRD.md](./docs/PRD.md) | Product requirements, goals, non-goals, success metrics |
| [Architecture.md](./docs/Architecture.md) | System components, request flow, key decisions |
| [API.md](./docs/API.md) | Endpoint reference |
| [Database.md](./docs/Database.md) | PostgreSQL schema and rationale |
| [Redis.md](./docs/Redis.md) | Key design, TTL strategy, atomicity approach |
| [Algorithms.md](./docs/Algorithms.md) | Rate limiting algorithms explained and compared |
| [Deployment.md](./docs/Deployment.md) | Docker/deployment guide |
| [Testing.md](./docs/Testing.md) | Testing strategy and coverage |

## Status

🚧 In active development — built milestone by milestone. See [ROADMAP.md](./ROADMAP.md) for current progress.

## Author

Vinay Anand Lodhi