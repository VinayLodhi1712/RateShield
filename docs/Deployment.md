# Deployment Guide — RateShield

**Version:** 1.0  
**Date:** 2026-08-14  
**Author:** Vinay Anand Lodhi  
**Status:** Active

---

## 1. Overview

RateShield is designed with a cloud-native, containerized architecture:
- **API Server (`backend`)**: Stateless Node.js Express server. Horizontally scalable across multiple container replicas behind a load balancer.
- **Redis (`redis`)**: In-memory store for high-throughput atomic rate limiting counters, windows, and token buckets.
- **PostgreSQL (`postgres`)**: Relational database for durable storage of users, policies, and refresh tokens.

---

## 2. Quick Start with Docker Compose (Local MVP)

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) & Docker Compose installed.

### 1-Click Startup
From the project root:

```bash
# Build and run all services in the background
docker compose up -d --build

# View real-time logs
docker compose logs -f api
```

### Seed Initial Policies & Admin User
Once the containers are running:

```bash
docker compose exec api npm run db:seed
```

This seeds:
1. Default Admin User: `admin@rateshield.io` (password: `AdminSecure2026!`)
2. Default Global Policy: 100 requests per 60 seconds (Fixed Window, fail-open)
3. Strict Login Policy: 5 requests per 60 seconds on `POST /auth/login` (fail-closed)

### Verify System Health
```bash
curl http://localhost:3000/health
```

Expected output:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "uptime": 24,
    "components": {
      "api": { "status": "healthy" },
      "redis": { "status": "healthy", "latencyMs": 1 },
      "postgres": { "status": "healthy", "latencyMs": 3 }
    }
  }
}
```

---

## 3. Environment Variables Reference

| Variable | Description | Example (Docker) |
|---|---|---|
| `PORT` | API server listening port | `3000` |
| `NODE_ENV` | Environment mode (`development`, `production`, `test`) | `production` |
| `JWT_SECRET` | 256-bit cryptographic secret for signing JWT tokens | `min_32_chars_random_string_here` |
| `JWT_EXPIRES_IN` | Access token lifespan | `15m` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://rateshield:rateshield@postgres:5432/rateshield` |
| `REDIS_URL` | Redis connection URL | `redis://redis:6379` |
| `LOG_LEVEL` | Winston logger level | `info` |

---

## 4. Production Deployment Guidelines

1. **Secrets Management**: Never commit real production `JWT_SECRET` or database passwords to source control. Inject them via your cloud provider (AWS Secrets Manager, Doppler, or GitHub Actions secrets).
2. **Persistent Volumes**: Ensure `rateshield_pgdata` and `rateshield_redisdata` volumes are backed up regularly.
3. **Scaling**: The API server is 100% stateless (JWTs verified locally, counters in Redis, policies in PostgreSQL + 30s local cache). You can scale the `api` container to multiple instances (`docker compose up --scale api=3`) behind Nginx or AWS ALB without session stickiness.
