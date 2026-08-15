# Deployment & Operations Guide — RateShield

**Version:** 2.0  
**Date:** 2026-08-16  
**Author:** Vinay Anand Lodhi  
**Status:** Active Production Guide

---

## 1. System Architecture Overview

RateShield is architected as a high-performance, cloud-native distributed rate limiter and token management platform.

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

## 2. Quick Start with Docker Compose

The entire stack (**PostgreSQL 16**, **Redis 7**, **RateShield API & UI**, **Prometheus**, and **Grafana**) launches with a single command.

### Prerequisites
- Docker Engine $\ge 24.0$ & Docker Compose $\ge 2.20$.

### 1-Click Startup
```bash
# 1. Clone the repository
git clone https://github.com/VinayLodhi1712/RateShield.git
cd RateShield

# 2. Build and launch all 5 containers
docker compose up -d --build

# 3. Apply database schema and initial seed data
docker compose exec api npm run db:seed
```

### Accessing Services
| Service | URL | Credentials |
|---|---|---|
| **RateShield Dashboard & API** | `http://localhost:3000` | Developer account / Register in UI |
| **Prometheus Metrics Explorer** | `http://localhost:9090` | Public / No Auth |
| **Grafana Telemetry Dashboard** | `http://localhost:3001` | Username: `admin` / Password: `admin` |
| **PostgreSQL (Host mapped)** | `localhost:5433` | `rateshield` / `rateshield` |
| **Redis (Host mapped)** | `localhost:6379` | Default no-auth in local container |

---

## 3. Environment Variables Reference

| Variable | Required | Description | Example (Production) |
|---|---|---|---|
| `PORT` | No | API listening port (default: 3000) | `3000` |
| `NODE_ENV` | Yes | Runtime environment mode | `production` |
| `JWT_SECRET` | Yes | 256-bit cryptographic signing secret | `min_32_chars_random_string_here` |
| `JWT_EXPIRES_IN` | No | Access token lifespan (default: 15m) | `15m` |
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@host:5432/rateshield?sslmode=require` |
| `REDIS_URL` | Yes | Redis connection string | `redis://:authpass@redis-host:6379` |
| `LOG_LEVEL` | No | Logging verbosity (`error`, `warn`, `info`, `debug`) | `info` |

---

## 4. Bare-Metal / Local Development Setup

If running without Docker:

```bash
# 1. Setup Backend
cd backend
npm install
cp .env.example .env # configure DATABASE_URL and REDIS_URL
npm run db:seed
npm run dev

# 2. Setup Next.js Frontend (in parallel terminal)
cd ../frontend
npm install
npm run dev
```

Visit `http://localhost:3000` in your browser.

---

## 5. Performance Benchmarking & Load Testing

Execute the automated k6 performance suite against your running deployment:

```bash
# Smoke test (baseline health verification)
k6 run load-tests/smoke.js

# Burst test (validates Lua atomicity and 429 throttling)
k6 run load-tests/burst.js

# Stress test (measures saturation up to 60 concurrent VUs)
k6 run load-tests/stress.js
```

---

## 6. Production Cloud Deployment (AWS / GCP / VPS)

### 1. Database & Cache Tier
- **PostgreSQL**: Deploy on managed database (AWS RDS PostgreSQL, Supabase, Neon) with connection pooling enabled.
- **Redis**: Deploy on AWS ElastiCache for Redis or Redis Enterprise in Multi-AZ configuration.

### 2. Stateless API Auto-Scaling
Because RateShield is 100% stateless:
- Deploy containerized API on **AWS ECS Fargate**, **Kubernetes (EKS/GKE)**, or **Render/Fly.io**.
- Configure Horizontal Pod Autoscaler (HPA) to scale between 2 and 20 replicas based on:
  - Target CPU utilization: $70\%$
  - Prometheus metric: `rateshield_http_requests_total > 500 req/s per pod`

### 3. Nginx Reverse Proxy with SSL (Production Template)
```nginx
server {
    listen 443 ssl http2;
    server_name api.rateshield.io;

    ssl_certificate /etc/letsencrypt/live/api.rateshield.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.rateshield.io/privkey.pem;

    location / {
        proxy_pass http://rateshield_api_upstream;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 7. Security Hardening Checklist

- [x] **Fail-Open Resilience**: Ensures upstream API availability during Redis network partitions without dropping customer traffic.
- [x] **Constant-Time Crypto**: SHA-256 hash comparison for API keys and bcrypt 12-round hashing for passwords.
- [x] **Rate Limit Isolation**: Separate buckets per IP, user identity, and API key prefix (`apikey:first8chars`).
- [x] **OWASP Security Headers**: Helmet HTTP protection with relaxed CSP for fonts and dashboard assets.
- [x] **Token Rotation**: Secure refresh token exchange with single-use replay revocation.
