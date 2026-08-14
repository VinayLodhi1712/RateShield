# Architecture — RateShield

**Version:** 1.0  
**Date:** 2026-07-29  
**Author:** Vinay Anand Lodhi  
**Status:** Draft — pending review

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Components](#2-components)
3. [Request Flow](#3-request-flow)
4. [Why Redis for Distributed Coordination](#4-why-redis-for-distributed-coordination)
5. [PostgreSQL vs Redis — Where Each Fits](#5-postgresql-vs-redis--where-each-fits)
6. [Deployment Topology](#6-deployment-topology)
7. [Architectural Decisions](#7-architectural-decisions)
8. [What Is Explicitly Out of Scope](#8-what-is-explicitly-out-of-scope)

---

## 1. System Overview

RateShield sits **in front of your application's actual business logic** and acts as a gatekeeper. Before any request reaches a handler that does real work (database queries, expensive computations, third-party API calls), it must pass through the rate-limiting middleware.

The core challenge it solves: **rate limiting across multiple server instances**. A single counter stored in one server's memory breaks the moment you run a second server — requests split across both servers, each counting independently, and clients can trivially exceed their limits. RateShield solves this by moving the counter to a shared, external store (Redis) that every server instance can see simultaneously.

### High-Level Diagram

```
+----------------------------------------------------------------------+
|                          Client Layer                                |
|              (browsers, mobile apps, curl, other services)           |
+-------------------------------+--------------------------------------+
                                |  HTTP Request
                                v
+----------------------------------------------------------------------+
|                       Express API Server(s)                          |
|                                                                      |
|   +----------------+   +---------------------+   +---------------+  |
|   |  Auth Middleware|-->| Rate Limit Middleware|-->|  Route Handler|  |
|   |  (JWT / API Key)|   | (algorithm engine)  |   |  (controller) |  |
|   +----------------+   +----------+----------+   +------+--------+  |
|                                   |                      |           |
+-----------------------------------+----------------------+-----------+
                                    |                      |
                      +-------------+            +---------+
                      v                          v
        +---------------------+      +----------------------+
        |       Redis          |      |      PostgreSQL       |
        |  (counters, windows, |      |  (users, API keys,   |
        |   token buckets,     |      |   policies, audit    |
        |   sliding logs, TTL) |      |   logs, analytics)   |
        +---------------------+      +----------------------+
                      |
        +-------------+
        v
+-----------------------------------+
|        Prometheus + Grafana        |
|  (metrics scraping, dashboards,   |
|   latency histograms, alert rules)|
+-----------------------------------+
```

---

## 2. Components

### 2.1 Express API Server

This is the Node.js/Express application. It is the only piece clients talk to directly. It is **stateless** — meaning it holds no data between requests. All state lives in Redis or PostgreSQL.

**Why stateless?** Because stateless servers can be cloned horizontally. If traffic doubles, you spin up another instance of the same server. No data migration, no coordination between instances beyond the shared Redis/Postgres stores.

**Responsibilities:**
- Receive HTTP requests
- Authenticate callers (JWT tokens, API keys)
- Invoke rate-limiting middleware before routing to handlers
- Expose admin APIs (policy management, metrics, health checks)
- Expose Swagger documentation

### 2.2 Auth Middleware

Runs on **every request — before the rate limiter and before any auth guard**. It attempts to decode the JWT or look up the API key and then does one of three things:

- **Valid credentials:** Sets `req.user = { id, role }`. The rate limiter will use `user:{id}` as the identity key.
- **No credentials at all (anonymous request):** Sets `req.user = null`. The rate limiter will fall back to `ip:{clientIp}` as the identity key. **The request is not rejected here** — an anonymous request to a public endpoint (e.g., `POST /auth/login`) is perfectly valid and must reach the rate limiter.
- **Invalid credentials (malformed/expired JWT, revoked key):** Returns `401` immediately and the rate limiter is skipped. There is no point spending a Redis call on a request that is provably invalid.

**Why decode before the rate limiter, even for anonymous requests?**  
JWT verification is a local cryptographic signature check against an in-memory secret — it takes ~0.1ms and requires zero network calls, zero database trips, and zero Redis calls. It is the cheapest thing the server can do. By running it first, the rate limiter always has the correct identity (`user:123` vs. `ip:...`) before executing its Redis Lua script. This means per-user policies are applied to authenticated users and IP policies are applied to anonymous traffic, without any ambiguity.

**Important distinction — auth middleware vs. auth guard:**  
These are two separate concerns, often confused:

- **Auth middleware** (this section): Decodes credentials. Sets `req.user`. Never rejects an anonymous request. Runs before the rate limiter.
- **Auth guard** (per-route, in the route handler): Checks whether `req.user` is set for routes that require it. Returns `401` if a protected route receives an anonymous request. Runs **after** the rate limiter.

This ordering ensures that an anonymous attacker probing a protected endpoint is still rate-limited by an IP policy before receiving their `401`. Without this, the `401` would be returned with no throttling, allowing unlimited unauthenticated probing.

**v1 Auth Strategy — Short Token Expiry, No JWT Blacklist:**  
JWTs are stateless by design: once issued, they are valid until they expire. A blacklist (storing revoked token IDs in Redis) would make every request incur an extra Redis lookup purely for auth — before even reaching the rate limiter. For v1, we avoid this cost by issuing short-lived access tokens (15-minute TTL) paired with a refresh-token flow (refresh tokens stored in PostgreSQL and revocable). This keeps the hot path lean: **JWT verification in v1 requires zero Redis calls and zero database calls.** A blacklist is an explicit non-goal for v1 and would only be added if token revocation requirements change (e.g., mandatory immediate logout on compromise).

### 2.3 Rate Limiting Middleware

The core of the project. Runs after auth middleware, before route handlers. Its job:

1. Determine the **identity key** for this request:
   - If `req.user` is set: identity = `user:{userId}` or `apikey:{prefix}`.
   - If `req.user` is null (anonymous): identity = `ip:{clientIp}`.
2. Look up the **policy** for this identity and endpoint from the policy cache. For anonymous requests, this resolves to an IP-based or global policy.
3. Execute the appropriate **algorithm** (Fixed Window, Sliding Window, Token Bucket, etc.) against Redis.
4. If the request is **within limits**: increment the counter atomically and let the request proceed to the route handler.
5. If the request **exceeds limits**: return `HTTP 429 Too Many Requests` immediately, with a `Retry-After` header. The route handler is never called.

All Redis operations in step 3 are executed as **atomic Lua scripts**. This is critical — see [Section 7, Decision 3](#decision-3-atomic-lua-scripts-for-redis-operations).

### 2.4 Redis

The shared coordination layer. Every server instance connects to the same Redis. Redis holds all *ephemeral, high-churn* data — the counters, windows, and token bucket states that change on every single request.

**Key namespace pattern:**
```
rateshield:{algorithm}:{identifier}:{endpoint}
```

Examples:
- `rateshield:fixed:user_123:POST:/login`
- `rateshield:token_bucket:apiKey_abc:GET:/data`
- `rateshield:sliding_log:192.168.1.1:*` (wildcard IP policy)

All keys have a **TTL** (Time to Live) set automatically. When a time window expires, Redis deletes the key on its own. No manual cleanup required.

### 2.5 PostgreSQL

The durable, relational store. Holds data that needs to survive a Redis restart and be queried in complex ways.

- **Users & roles** — who can log in, what permissions they have
- **API keys** — hashed API keys tied to a user
- **Rate limit policies** — which algorithm, what limit, what window, for which user/IP/endpoint
- **Audit logs** — who was rate-limited, when, why
- **Analytics aggregates** — daily/hourly summaries for the dashboard

### 2.6 Prometheus & Grafana

**Prometheus** is a monitoring system that periodically "scrapes" (polls) a `/metrics` endpoint on the API server. The API server exposes counters and histograms there using the `prom-client` Node.js library.

**Grafana** connects to Prometheus as a data source and renders live dashboards.

Metrics exposed include:
- `rateshield_requests_total` — total requests, labeled by endpoint and outcome (allowed/blocked)
- `rateshield_request_duration_seconds` — latency histograms
- `rateshield_redis_operations_total` — Redis call counts
- `rateshield_active_policies_total` — number of active rate limit policies

### 2.7 Winston Logger

Structured JSON logging at every layer. Logs include `requestId`, `userId`, `endpoint`, `algorithm`, `outcome`, and latency. Written to stdout in development, and intended to be shipped to a log aggregator (e.g., Loki, Datadog) in production.

---

## 3. Request Flow

Let's trace a single API request from start to finish. Understanding this flow is the most important thing to internalize before touching any code.

### 3.1 Happy Path — Request Allowed

```
Step 1:  Client sends: GET /api/data
         Headers: Authorization: Bearer <JWT>

Step 2:  Auth Middleware
         - Decodes JWT -> extracts userId="user_123", role="developer"
         - Attaches to req.user
         - No database call for JWT (secret is in memory)

Step 3:  Rate Limit Middleware — Policy Lookup
         - Builds identity key: "user_123"
         - Queries policy: "developer" role -> 1000 req/min on /api/data
         - Policy lookup: checked against in-memory cache first (TTL ~30s),
           falls back to PostgreSQL if cache miss
         - Selects algorithm: Token Bucket (as configured for this policy)

Step 4:  Rate Limit Middleware — Redis Operation
         - Executes Lua script on Redis:
             KEY = "rateshield:token_bucket:user_123:GET:/api/data"
             -> atomically checks current tokens, refills based on elapsed time,
                decrements by 1, returns {allowed: true, remaining: 847}
         - Total time: ~1-3ms (Redis is in-memory and local network)

Step 5:  Request Proceeds to Route Handler
         - Response headers set: X-RateLimit-Limit: 1000
                                  X-RateLimit-Remaining: 847
                                  X-RateLimit-Reset: 1722345600
         - Handler executes business logic, returns HTTP 200

Step 6:  Metrics Updated
         - Prometheus counter incremented: outcome="allowed"
         - Latency recorded in histogram
```

### 3.2 Blocked Path — Request Rejected

```
Step 1-3: Same as above

Step 4:  Redis Operation
         - Lua script returns {allowed: false, remaining: 0, retryAfter: 42}

Step 5:  Rate Limit Middleware short-circuits
         - Does NOT call the route handler
         - Returns: HTTP 429 Too Many Requests
           Headers: Retry-After: 42
                    X-RateLimit-Limit: 1000
                    X-RateLimit-Remaining: 0

Step 6:  Metrics Updated
         - outcome="blocked"
         - Optional: audit log entry written to PostgreSQL asynchronously
```

**Key insight:** When a request is rejected, only Redis was touched — no route handler, no business logic, no expensive computation. The rejection is as cheap as possible. That is the whole point.

### 3.3 Policy Cache Flow

PostgreSQL is not on the hot path for every request. Hitting the database every time would defeat the purpose of having fast rate limiting.

```
Request arrives
    |
    v
Is policy in memory cache?
    +-- YES (cache hit, ~30s TTL) --> use cached policy
    +-- NO  (cache miss)
            |
            v
        Query PostgreSQL for policy
            |
            v
        Store in memory cache with 30s TTL
            |
            v
        Use policy
```

The memory cache lives inside the Node.js process. This means each server instance caches independently — a policy change in PostgreSQL propagates within 30 seconds as caches expire naturally. This is an acceptable trade-off: a 30-second propagation delay in exchange for zero inter-process cache coordination complexity.

---

## 4. Why Redis for Distributed Coordination

This is the most important architectural question in the project. If you are new to Redis, read this section carefully.

### 4.1 The Problem Redis Solves

Imagine two server instances, A and B. A user has a limit of 100 requests per minute. Requests are load-balanced 50/50.

**Without Redis (in-memory counters):**
- Server A sees 100 requests → counts 100 → allows all
- Server B sees 100 requests → counts 100 → allows all
- User effectively made 200 requests — double their limit
- **The rate limiter is broken.**

**With Redis (shared counter):**
- Server A increments Redis counter for the user
- Server B increments the *same* Redis counter for the user
- Both servers see the same count → limit enforced correctly

Redis is the single source of truth for all counters.

### 4.2 Why Redis Specifically (Not Something Else)

Redis has three properties that make it almost uniquely suitable for this use case:

**1. In-memory storage = microsecond reads/writes**  
Redis stores everything in RAM. A typical Redis `GET` or `INCR` operation takes 0.1–1ms on a local network. A PostgreSQL query to do the same thing would take 5–20ms minimum (disk I/O, query planner overhead, connection pool, etc.). For rate limiting, this latency is added to *every single request*. Saving 10–20ms per request is enormous at scale.

**2. Atomic single-command operations**  
Redis has built-in atomic commands like `INCR`, `EXPIRE`, `SETNX`. "Atomic" means the operation completes as a single, indivisible unit — no two clients can interleave in the middle of an `INCR`. This is what makes it safe for counters: if 10 server instances all `INCR` the same key simultaneously, each gets the correct post-increment value. No counter is lost or double-counted.

**3. TTL (Time to Live) built-in**  
Every Redis key can have an expiry time. `EXPIRE rateshield:fixed:user_123 60` tells Redis to delete that key after 60 seconds. This maps naturally to rate limiting windows: the counter for a 1-minute Fixed Window simply expires after 60 seconds. Redis handles cleanup automatically — no background job, no cron, no `DELETE WHERE created_at < NOW()`.

### 4.3 Alternatives Considered

| Option | Why Not Chosen |
|---|---|
| **In-memory (single instance)** | Breaks with multiple servers (see 4.1 above). Only works for a single-server deployment. |
| **PostgreSQL for counters** | Too slow for the hot path. Every request would require a transaction with a `SELECT ... FOR UPDATE` or `INSERT ... ON CONFLICT DO UPDATE`. Under load this creates lock contention and latency spikes. |
| **Memcached** | No atomic `INCR` + `EXPIRE` in a single operation. No Lua scripting. No persistence. More limited data structures. Redis is strictly better for this use case. |
| **DynamoDB / other NoSQL** | Cloud-native, higher latency than local Redis, more complex to run locally for development and load testing. Viable in production but unnecessary complexity for this project's goals. |
| **Hazelcast / Apache Ignite** | Distributed in-memory grids. Solve the same problem but are heavier, Java-based, harder to deploy locally, and overkill for this project's scale targets. |

### 4.4 Trade-offs of Choosing Redis

Redis is not a silver bullet. Here are honest trade-offs:

| Trade-off | Detail |
|---|---|
| **Single point of failure** | If Redis goes down, the rate limiter goes down. Mitigation: Redis Sentinel (auto-failover) or Redis Cluster. For this project's scope, a single Redis instance is acceptable — documented explicitly. |
| **Memory-limited storage** | Everything in Redis must fit in RAM. Counters are tiny (bytes each), so this is not a concern at our scale, but worth knowing. |
| **Eventual correctness window** | Lua scripts are atomic per-key, but across multiple keys (e.g., sliding log with many timestamp entries) there is complexity. This is handled per-algorithm — see `docs/Algorithms.md`. |
| **No complex querying** | You cannot run `GROUP BY`, joins, or aggregations in Redis. Analytical queries (dashboard reports, audit history) must go to PostgreSQL. |

---

## 5. PostgreSQL vs Redis — Where Each Fits

A common confusion: "we have Redis, why do we also need PostgreSQL?" The answer is that they solve completely different problems.

Think of Redis as a **whiteboard in the room** — fast to read and write, visible to everyone simultaneously, but the moment you erase the board (or the power goes out), the data is gone. It is designed for *right now*.

Think of PostgreSQL as a **filing cabinet** — slower to access, but permanent, searchable, relational, and transactionally correct. It is designed for *history and decisions*.

| Concern | Redis | PostgreSQL |
|---|---|---|
| **Rate limit counters** | Primary store | Too slow |
| **TTL-based key expiry** | Native built-in | Needs a cron job |
| **User accounts & passwords** | No joins, no ACID | Primary store |
| **API keys** | Not relational | Primary store |
| **Rate limit policies** | Cached copy only | Primary store (source of truth) |
| **Audit logs** | Not persistent enough | Primary store |
| **Analytics aggregates** | No aggregation | Primary store |
| **JWT blacklist** | *(Not used in v1 — see Section 2.2)* | *(Not used in v1)* |
| **Admin dashboard data** | Hard to aggregate | Primary store |

**Rule of thumb:** If data expires naturally and is read/written on every request → Redis. If data must survive a restart, be queried relationally, or audited → PostgreSQL.

---

## 6. Deployment Topology

### 6.1 Single Instance (Development / Local)

The simplest deployment. One of everything. Useful for development, testing, and understanding the system before scaling it.

```
+--------------------------------------------+
|             Docker Compose                 |
|                                            |
|   +--------------+   +------------------+ |
|   |  API Server  |   |     Redis        | |
|   |  (Node.js)   |<->|  (single node)   | |
|   |  port 3000   |   |  port 6379       | |
|   +------+-------+   +------------------+ |
|          |                                 |
|   +------v-------+   +------------------+ |
|   |  PostgreSQL  |   |   Prometheus     | |
|   |  port 5432   |   |   port 9090      | |
|   +--------------+   +------------------+ |
|                                            |
|                      +------------------+  |
|                      |     Grafana      |  |
|                      |   port 3001      |  |
|                      +------------------+  |
+--------------------------------------------+
```

All services share a Docker network. The API server refers to Redis as `redis:6379` (Docker service name), not `localhost:6379`. This is managed via environment variables.

Started with: `docker compose -f docker/docker-compose.yml up -d`

**Limitation:** If the single API server goes down, the service is unavailable. If Redis goes down, rate limiting fails.

### 6.2 Horizontally Scaled (Conceptual Production)

The architecture is designed to support this from day one, even though we will not deploy it this way. "Designed for horizontal scaling" means: no sticky sessions, no in-process shared state for request counting, and stateless API servers.

```
                        +--------------+
         Clients ------>| Load Balancer|
                        | (nginx/LB)   |
                        +------+-------+
                               |
              +----------------+----------------+
              v                v                v
     +------------+   +------------+   +------------+
     |  API #1    |   |  API #2    |   |  API #3    |
     | (Node.js)  |   | (Node.js)  |   | (Node.js)  |
     +-----+------+   +-----+------+   +-----+------+
           |                |                |
           +----------------+----------------+
                            |
                +-----------v----------+
                |   Redis (shared)      |
                |   Single node OR      |
                |   Sentinel cluster    |
                +----------------------+
```

**Why this works:** Since every API instance uses the same Redis for counters, a user hitting API #1 and API #2 on different requests still shares the same counter. The rate limiter is correct regardless of which server handles each request.

**The one caveat — Redis is still a shared dependency.** Scaling the API layer is straightforward. Making Redis itself highly available requires either:
- **Redis Sentinel**: monitors one primary Redis, promotes a replica automatically on failure. Adds ~100–200ms failover lag.
- **Redis Cluster**: shards keys across multiple Redis nodes. More complex but higher throughput ceiling.

For this project, we use a single Redis node and document the production upgrade path. This is a legitimate choice — many high-traffic production systems start with a single Redis with Sentinel before reaching the complexity of Cluster.

---

## 7. Architectural Decisions

Each decision below is an explicit choice with a reason. Documenting decisions this way is a practice borrowed from Architecture Decision Records (ADRs). The goal is to answer the interview question "why did you do it this way?" with honesty about trade-offs.

---

### Decision 1: Stateless API Servers

**Decision:** The Express server holds no request state between calls. All persistent state lives in Redis or PostgreSQL.

**Why:** Stateless servers can be replicated without coordination. You can run 1 or 10 instances of the same Docker image and they behave identically. This is the foundation of horizontal scalability.

**Trade-off:** You pay a small latency cost on every request because you must reach out to Redis or PostgreSQL instead of reading from in-process memory. This is why the policy cache (Section 3.3) exists — to keep the hot path touching Redis once per request, not PostgreSQL.

---

### Decision 2: Redis for Hot State, PostgreSQL for Cold State

**Decision:** Rate limit counters → Redis. Everything else that requires durability or relational queries → PostgreSQL.

**Why:** Matching the right tool to the right problem. Redis is 10–100x faster than PostgreSQL for simple key-value reads/writes. PostgreSQL is vastly more capable for relational queries, ACID guarantees, and long-term storage.

**Trade-off:** You now have two databases to operate, back up, and understand. This adds operational complexity. The payoff is correctness at speed — you cannot achieve both with a single tool.

---

### Decision 3: Atomic Lua Scripts for Redis Operations

**Decision:** Rate limiter logic (check counter → compare to limit → increment if allowed) is implemented as a Lua script executed on the Redis server, not as multiple sequential Redis commands from Node.js.

**Why:** Consider this naive multi-step approach:

```javascript
// WRONG — race condition
const count = await redis.get(key)     // step 1
if (count < limit) {
  await redis.incr(key)                // step 2
  allowRequest()
}
```

Between step 1 and step 2, another server instance could also read the same count and also decide to allow the request. Both increment. The counter is now over the limit, but both requests were allowed. This is a **race condition** — the kind of bug that only appears under real concurrent load and is nearly impossible to reproduce in testing.

Lua scripts on Redis are guaranteed to execute atomically — no other command can run on that Redis instance between the start and end of the script. This eliminates the race condition entirely.

**Trade-off:** Lua scripts are harder to write and debug than straightforward JavaScript. They must be kept simple (Redis Lua has a restricted environment). Logic errors in a Lua script are harder to trace. Worth it — correctness is non-negotiable for a rate limiter.

---

### Decision 4: In-Process Policy Cache (30s TTL)

**Decision:** Rate limit policies are cached in the Node.js process memory for up to 30 seconds before being re-fetched from PostgreSQL.

**Why:** Without this cache, every request would require a PostgreSQL query to load the policy. A database query adds 5–20ms per request. At 1,000 concurrent requests/second, that is 1,000 database queries/second just for policy lookups — easily overwhelming a PostgreSQL instance.

**Trade-off:** Policy changes (e.g., an admin bans a user by setting their limit to 0) take up to 30 seconds to propagate. This is called **eventual consistency** — the system will eventually reach the correct state, but there is a window where it is not yet correct. For a rate limiter, 30 seconds is an acceptable lag. If you needed instant propagation, you would publish an invalidation event to a message queue (e.g., Redis Pub/Sub), which adds complexity. This is documented as a known limitation.

---

### Decision 5: Five Rate Limiting Algorithms

**Decision:** Implement all five algorithms (Fixed Window, Sliding Window, Sliding Log, Token Bucket, Leaky Bucket) as independently selectable strategies, not just one.

**Why:** Different APIs have different characteristics. A login endpoint needs strict per-window limits (Fixed Window). A streaming data API needs smooth, burst-tolerant limiting (Token Bucket). There is no single best algorithm for all cases. Implementing all five is also the educational goal of this project.

**Trade-off:** More code, more tests, more Redis key patterns to document. Each algorithm has its own Redis data structure: Fixed Window uses a simple counter, Sliding Log uses a sorted set, Token Bucket uses a hash with `tokens` and `lastRefill` fields. This is documented in `docs/Algorithms.md`.

---

### Decision 6: Docker Compose for Local Development

**Decision:** The entire stack (API, Redis, PostgreSQL, Prometheus, Grafana) is orchestrated with Docker Compose, not run manually.

**Why:** "It works on my machine" is a real problem. Docker Compose guarantees that every developer (and the CI environment) uses the same versions of Redis, PostgreSQL, and Prometheus with the same configuration. A single command brings up the entire system: `docker compose up -d`. This also makes the project immediately approachable for anyone who wants to run it.

**Trade-off:** Requires Docker installed locally. Adds a conceptual overhead for developers unfamiliar with containers. First-time setup downloads Docker images (~1–2GB). This is a widely accepted trade-off in modern backend development.

---

### Decision 7: Prometheus Metrics over Custom Logging for Observability

**Decision:** Expose a `/metrics` endpoint in the Prometheus text format, scraped by Prometheus, visualized in Grafana. Do not build a custom metrics pipeline.

**Why:** Prometheus + Grafana is the de facto standard for application metrics in backend engineering. It is what you will encounter at virtually every company. Using it here means learning the industry standard, not an invented one. The `prom-client` Node.js library handles all the hard parts.

**Trade-off:** Adds two services (Prometheus, Grafana) to the Docker Compose stack. Requires understanding the pull-based scraping model (Prometheus polls your app, rather than your app pushing metrics out). For most applications this is the right call; push-based models (e.g., statsd) exist but are less common for this use case.

---

### Decision 8: Single Redis Node (Not Cluster) for v1

**Decision:** Use a single Redis instance for the initial implementation. Redis Sentinel or Redis Cluster are documented as upgrade paths but not implemented in v1.

**Why:** Redis Cluster adds significant complexity: key slot hashing, multi-node Lua script restrictions, cross-slot operations. A single Redis node is sufficient for the success metrics (1,000 concurrent requests, p99 < 50ms). Adding Cluster before it is needed is premature optimization and would make the codebase harder to understand.

**Trade-off:** Single point of failure on Redis. If Redis goes down, rate limiting fails. In a production system you would always run Redis with at minimum Sentinel (one primary + one replica + one sentinel monitor). This is explicitly noted as a known limitation of v1, with the upgrade path documented in `docs/Deployment.md`.

---

## 8. What Is Explicitly Out of Scope

The PRD's Non-Goals are restated here in architectural terms so there is no ambiguity.

| Out of Scope | Architectural Implication |
|---|---|
| **Microservices** | RateShield is a monolith. All features live in one Express process. No service mesh, no inter-service communication, no separate deployments per feature. |
| **Kubernetes** | Deployment is Docker Compose only. Kubernetes would be the next step for production orchestration, but adds substantial complexity for no benefit at this project's scale. |
| **Machine Learning / AI** | No anomaly detection, no adaptive limits, no ML-based abuse classification. Policies are rule-based, configured by admins. |
| **Billing / Payments** | No metered billing tied to rate limit tiers. |
| **User Interface complexity** | The admin dashboard is intentionally minimal. It reads data from admin APIs; it does not contain business logic. |

---

*Next documents to read:*
- [`docs/Redis.md`](./Redis.md) — Key design, TTL strategy, and atomicity approach (algorithm-level detail)
- [`docs/Algorithms.md`](./Algorithms.md) — Each of the five rate limiting algorithms explained with diagrams
- [`docs/Database.md`](./Database.md) — PostgreSQL schema and rationale
