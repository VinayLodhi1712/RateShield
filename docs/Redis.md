# Redis Design — RateShield

**Version:** 1.0  
**Date:** 2026-07-30  
**Author:** Vinay Anand Lodhi  
**Status:** Draft — pending review

---

## Table of Contents

1. [What This Document Covers](#1-what-this-document-covers)
2. [Redis Fundamentals (for First-Timers)](#2-redis-fundamentals-for-first-timers)
3. [Key Naming Convention](#3-key-naming-convention)
4. [TTL Strategy](#4-ttl-strategy)
5. [Lua Scripts for Atomicity](#5-lua-scripts-for-atomicity)
6. [Redis Connection Failure — Fail-Open](#6-redis-connection-failure--fail-open)
7. [Memory Footprint Estimate](#7-memory-footprint-estimate)
8. [Open Questions and Decisions](#8-open-questions-and-decisions)

---

## 1. What This Document Covers

`Architecture.md` explains *why* Redis is used. This document goes one level deeper and explains *how* it is used — at the key and operation level.

After reading this document you should be able to answer:

- What does a Redis key look like for each of the five algorithms?
- When does a key expire, and why that TTL specifically?
- Why can't we just send multiple commands from Node.js? Why do we need Lua?
- What does the system do when Redis is unreachable?
- How much RAM does this actually consume?

This document intentionally avoids Node.js code — it captures design decisions only. The implementation lives in `backend/src/limiters/`.

---

## 2. Redis Fundamentals (for First-Timers)

> **Skip this section if you already know Redis.** It is here because the PRD states that learning Redis is one of the explicit goals of this project.

### What is a Redis key?

Redis is a key-value store. Think of it as a giant dictionary where every key is a string and every value can be one of several data types. The most important types for this project are:

| Type | Description | Used For |
|---|---|---|
| **String** | A single value. Can be an integer or text. | Fixed Window counter, Sliding Window counter |
| **Sorted Set** | A set of members, each with a floating-point score, always kept sorted by score. | Sliding Log (timestamps as scores) |
| **Hash** | A mini-dictionary inside a key — multiple field:value pairs under one key. | Token Bucket (tokens + lastRefill), Leaky Bucket (queue + lastLeak) |

### What is a TTL?

Every Redis key can be given a **Time to Live (TTL)** — a countdown in seconds or milliseconds. When the countdown hits zero, Redis deletes the key automatically. You never need a cron job or cleanup script.

```
redis> SET my-key "hello"
redis> EXPIRE my-key 60     <- delete this key after 60 seconds
redis> TTL my-key           <- how many seconds remain?
(integer) 58
```

This is crucial for rate limiting: a "1 request per minute" window counter simply expires after 60 seconds. The next request starts a fresh counter.

### What does "atomic" mean?

Atomic means **all-or-nothing, with no interruption possible in the middle**.

Redis processes commands one at a time (it is single-threaded for command processing). A single command like `INCR` is inherently atomic. But a sequence of commands — say, GET the counter, compare it, then INCR it — is NOT atomic. Another client can sneak a command in between your GET and your INCR.

This is why we use **Lua scripts**: Redis executes an entire Lua script as a single atomic unit. No other client command can interrupt it. See Section 5 for full details.

---

## 3. Key Naming Convention

### Base Pattern

```
rateshield:{algorithm}:{identifier}:{endpoint}
```

Each segment is separated by a colon (`:`). This is a Redis community convention for namespacing — it has no technical significance (colons are just characters to Redis), but it makes keys human-readable in monitoring tools like RedisInsight.

| Segment | Meaning | Possible Values |
|---|---|---|
| `rateshield` | Global namespace — prevents collisions with other apps sharing the same Redis | Always `rateshield` |
| `{algorithm}` | Which algorithm owns this key | `fixed`, `sliding_window`, `sliding_log`, `token_bucket`, `leaky_bucket` |
| `{identifier}` | Who is being rate-limited | `user:{id}`, `apikey:{key_prefix}`, `ip:{address}` |
| `{endpoint}` | Which API endpoint this limit applies to | `GET:%2Fapi%2Fdata`, `POST:%2Fauth%2Flogin`, `*` (wildcard = all endpoints) |

> **Note on URL encoding:** The `/` characters in endpoint paths are encoded as `%2F` to prevent key parsing ambiguity. For example, `/api/data` becomes `%2Fapi%2Fdata`. This ensures the colons in the key pattern always mean "segment separator" and nothing else.

### Why include the endpoint in the key?

Different endpoints can have different policies for the same user. Example:

- `user:123` is allowed 1,000 requests/min on `GET:/api/data` (a read endpoint)
- `user:123` is allowed only 5 requests/min on `POST:/auth/login` (a sensitive write endpoint)

If the key only contained the user ID, a single counter would be shared across all endpoints and the per-endpoint limits would be impossible to enforce independently.

### Real Examples — All Five Algorithms

#### Algorithm 1: Fixed Window

**Data structure:** String (integer counter)  
**One key per (user, endpoint, time window)**

```
rateshield:fixed:user:123:GET:%2Fapi%2Fdata:1722345600
                                            |
                               Unix timestamp of window start
                               (floor of current time to window size)
```

- The timestamp at the end represents the start of the current 60-second window.
- When the window rolls over (new minute), a new key is created automatically. The old one expires.
- Example value: `"847"` (integer stored as a Redis string)

**More examples:**

```
rateshield:fixed:user:123:POST:%2Fauth%2Flogin:1722345600
rateshield:fixed:apikey:abc12345:GET:%2Fapi%2Fdata:1722345600
rateshield:fixed:ip:192.168.1.1:*:1722345600
```

---

#### Algorithm 2: Sliding Window

**Data structure:** String (integer counter for the current window) + a previous window key  
**Two keys consulted per request: current window and previous window**

The sliding window approximation works by blending the previous window's count with the current window's count, weighted by how far we are through the current window.

```
rateshield:sliding_window:user:123:GET:%2Fapi%2Fdata:1722345600   <- current window
rateshield:sliding_window:user:123:GET:%2Fapi%2Fdata:1722345540   <- previous window (60s earlier)
```

- Both are plain integer counters.
- At request time: `blended_count = prev_count * overlap_fraction + curr_count`
- If `blended_count < limit`, allow and increment `curr_count`.
- The previous window key is read but never written to.

---

#### Algorithm 3: Sliding Log

**Data structure:** Sorted Set  
**One key per (user, endpoint) — no timestamp segment**

```
rateshield:sliding_log:user:123:POST:%2Fauth%2Flogin
```

The key never contains a timestamp because the sorted set itself IS the log of timestamps. Each member of the set is a unique request identifier, and its **score** is the Unix timestamp (in milliseconds) of when that request arrived.

```
ZADD rateshield:sliding_log:user:123:POST:%2Fauth%2Flogin 1722345612345 "req-uuid-1"
ZADD rateshield:sliding_log:user:123:POST:%2Fauth%2Flogin 1722345613210 "req-uuid-2"
```

To count requests in the last 60 seconds:
```
ZCOUNT key (now - 60000ms) now
```

Redis does this range query in O(log N) time. Old entries (outside the window) are removed with `ZREMRANGEBYSCORE`.

---

#### Algorithm 4: Token Bucket

**Data structure:** Hash  
**One key per (user, endpoint) — no timestamp segment**

```
rateshield:token_bucket:user:123:GET:%2Fapi%2Fdata
```

The hash contains exactly two fields:

```
HGETALL rateshield:token_bucket:user:123:GET:%2Fapi%2Fdata
1) "tokens"      -> "847.5"          <- current token count (float)
2) "lastRefill"  -> "1722345612345"  <- Unix timestamp in ms of last refill
```

Why a hash instead of two separate keys? Because the Lua script needs to read and write both fields atomically — they must be updated together. A single hash key with two fields is one atomic operation; two separate string keys would require a multi-key transaction, which is harder to reason about.

---

#### Algorithm 5: Leaky Bucket

**Data structure:** Hash  
**One key per (user, endpoint)**

```
rateshield:leaky_bucket:user:123:POST:%2Fapi%2Fsubmit
```

The hash contains:

```
HGETALL rateshield:leaky_bucket:user:123:POST:%2Fapi%2Fsubmit
1) "queue"      -> "3"              <- current items waiting to be processed
2) "lastLeak"   -> "1722345612345" <- Unix timestamp in ms of last leak calculation
```

The "leak" is virtual — we don't maintain an actual queue of requests in Redis. Instead, on every request, we compute how many items would have drained since `lastLeak`, subtract them from `queue`, then attempt to add one new item. If `queue` is already at capacity, the request is rejected.

---

### Identifier Prefix Convention

To distinguish users from API keys from IP addresses (since they all could have similar-looking values), identifiers are always prefixed:

| Identity Type | Format | Example |
|---|---|---|
| Authenticated user | `user:{userId}` | `user:123` |
| API key holder | `apikey:{first8chars}` | `apikey:abc12345` |
| Unauthenticated IP | `ip:{address}` | `ip:192.168.1.1` |

> **Why only the first 8 chars of an API key?** Full API keys in Redis keys would be a security risk if Redis memory is ever dumped. The first 8 characters are enough to distinguish keys for rate limiting purposes while keeping secrets off the key surface.

---

## 4. TTL Strategy

TTLs serve two purposes:
1. **Correctness** — the window resets automatically when the time period ends.
2. **Memory cleanup** — keys for inactive users are deleted automatically without any cron job.

### Per-Algorithm TTL Table

| Algorithm | Key(s) | TTL Applied To | TTL Value | Why This Value |
|---|---|---|---|---|
| **Fixed Window** | `rateshield:fixed:...:{windowStart}` | The counter key | `windowSize + 1s` | The window expires when the next window starts. +1s prevents edge-case early deletion due to clock rounding. |
| **Sliding Window** | `rateshield:sliding_window:...:{windowStart}` | Each window counter | `windowSize * 2 + 1s` | The previous window is still read during the first half of the next window. TTL must cover the window itself plus the overlap period. |
| **Sliding Log** | `rateshield:sliding_log:...` | The sorted set key | `windowSize + grace (e.g. 2x windowSize)` | No fixed windows — the key stays alive as long as requests are coming. A grace period ensures the key survives brief lulls. TTL is refreshed on every request with `EXPIRE`. |
| **Token Bucket** | `rateshield:token_bucket:...` | The hash key | Long-lived (e.g., 24 hours), refreshed on access | The bucket state must survive across requests. TTL is reset on every request. A 24-hour fallback deletes the key for truly inactive users to free memory. |
| **Leaky Bucket** | `rateshield:leaky_bucket:...` | The hash key | Same as Token Bucket | Same reasoning — bucket state is persistent per-user but expires for idle users. |

### How TTL is Set in Practice

**Fixed Window — set once at creation:**

```
On the first request in a new window:
  SET key "1" EX {windowSize + 1}
  (Combined SET + EXPIRE in one command — atomic by default)

On subsequent requests in the same window:
  INCR key
  (TTL already set; we don't touch it again)
```

**Token Bucket / Leaky Bucket — refresh on every access:**

```
After every Lua script execution:
  EXPIRE key 86400   <- 24 hours from NOW
```

This "sliding expiry" means a user who makes one request per day never loses their bucket state. A user who goes quiet for 24+ hours has their bucket deleted — which is fine, because on their next request we re-initialize the bucket to full capacity anyway.

### Why Not Set All TTLs to "Forever"?

Redis is an in-memory store. Memory is finite. If we never expired keys, every user who ever made a request would leave a key in Redis forever — even if they never return. At 100,000 users, that is manageable. At 10 million users over time, it becomes a silent memory leak. TTLs are the mechanism that keeps memory bounded automatically.

---

## 5. Lua Scripts for Atomicity

### The Problem (Why Node.js Alone Is Not Enough)

Imagine this sequence of Node.js commands for Fixed Window:

```
Step 1 (Node.js):  GET key             -> returns "99"
Step 2 (Node.js):  99 < 100, so...
Step 3 (Node.js):  INCR key            -> sets key to "100"
Step 4 (Node.js):  allow request
```

This looks correct. But now imagine two Node.js servers processing requests simultaneously:

```
Server A reads key -> "99"
Server B reads key -> "99"   <- Both read 99 at the same instant
Server A increments -> "100" <- allowed
Server B increments -> "101" <- also allowed!
```

Both servers thought the count was 99 (under the limit of 100), so both allowed their request. The counter is now 101 — **one over the limit** — and neither server knew. This is a **race condition**. It is the exact bug that causes rate limiters to fail under real concurrent load.

### The Solution: Lua Scripts on Redis

A Lua script sent to Redis executes **entirely on the Redis server**, as a single atomic block. Redis processes commands one at a time — no other client's command can interrupt a running Lua script. The race condition is impossible.

Think of it this way:
- **Multi-step Node.js commands** = two people editing the same Google Doc simultaneously (last write wins, intermediate states visible to both)
- **Lua script on Redis** = one person locks the document, makes all their changes, then unlocks it (others queue and wait)

### Fixed Window — Lua Script Logic

**Inputs to the script:**
- `KEY`: the full Redis key, e.g. `rateshield:fixed:user:123:GET:%2Fapi%2Fdata:1722345600`
- `LIMIT`: the maximum allowed requests, e.g. `100`
- `WINDOW_SECONDS`: the window size in seconds, e.g. `60`

**Logic (in plain English / pseudocode):**

```
1. GET the current value of KEY from Redis.

2. If KEY does not exist (this is the first request in this window):
     SET KEY to 1
     SET the TTL of KEY to (WINDOW_SECONDS + 1)
     RETURN { allowed: true, count: 1, remaining: LIMIT - 1 }

3. If KEY exists:
     current = integer value of KEY

     If current >= LIMIT:
       RETURN { allowed: false, count: current, remaining: 0 }
     Else:
       INCR KEY by 1       <- atomic: read-and-increment in one step on Redis
       new_count = current + 1
       RETURN { allowed: true, count: new_count, remaining: LIMIT - new_count }
```

**Why this is safe:** Steps 1 through RETURN execute as one uninterruptible block on Redis. No other client can read or write `KEY` between step 1 and the final INCR.

**Why INCR and not SET(current + 1)?** `INCR` is a single atomic Redis command — it reads and writes in one indivisible step. `SET(current + 1)` would require reading the value first (in a separate step), making it non-atomic. Lua gives us the framework, but we still use the most atomic Redis commands available inside the script.

---

### Token Bucket — Lua Script Logic

Token Bucket is more complex because the number of available tokens depends on how much time has elapsed since the last refill — a calculation that must happen inside the same atomic block.

**Inputs to the script:**
- `KEY`: e.g. `rateshield:token_bucket:user:123:GET:%2Fapi%2Fdata`
- `CAPACITY`: maximum tokens, e.g. `100`
- `REFILL_RATE`: tokens added per second, e.g. `10` (10 tokens/sec = 600/min)
- `NOW_MS`: current timestamp in milliseconds (passed in from Node.js — Redis has a `TIME` command but passing it in avoids clock drift inside the script)
- `TTL_SECONDS`: how long to keep the key alive if idle, e.g. `86400`

**Logic (in plain English / pseudocode):**

```
1. HGETALL KEY -> get both fields: { tokens, lastRefill }

2. If KEY does not exist (no fields returned):
     tokens = CAPACITY    <- fresh bucket, start full
     lastRefill = NOW_MS

3. If KEY exists:
     elapsed_seconds = (NOW_MS - lastRefill) / 1000

     tokens_to_add = elapsed_seconds * REFILL_RATE

     tokens = min(tokens + tokens_to_add, CAPACITY)
               ^-- never exceed the bucket's maximum capacity

     lastRefill = NOW_MS   <- update the refill timestamp

4. If tokens < 1:
     <- not enough tokens for this request
     Write back { tokens, lastRefill } to Redis hash
     EXPIRE KEY TTL_SECONDS
     RETURN { allowed: false, remaining: 0 }

5. If tokens >= 1:
     tokens = tokens - 1   <- consume one token

     Write back { tokens: tokens, lastRefill: NOW_MS } to Redis hash
     EXPIRE KEY TTL_SECONDS
     RETURN { allowed: true, remaining: floor(tokens) }
```

**Key insight — why the refill is computed inside Lua:**

The refill calculation (step 3) depends on `lastRefill`. If this were split across two Redis calls — one to READ `lastRefill`, then one to WRITE the new state — another request could sneak in between and:

- Both requests read the same `lastRefill` and compute the same refilled token count.
- Both consume a token from that count.
- Both write back the same `tokens - 1`.
- Result: two requests consumed, but only one token deducted. Limit bypassed.

By doing the full read-compute-write cycle inside one Lua script, this race is eliminated.

---

### Why the Other Three Algorithms Also Need Lua

| Algorithm | Race Condition if Not Atomic |
|---|---|
| **Sliding Window** | Reading both window counters and deciding whether to increment the current one must be atomic — otherwise two concurrent requests could both read the same blended count and both be allowed even if together they exceed the limit. |
| **Sliding Log** | `ZREMRANGEBYSCORE` (prune old entries) + `ZCOUNT` (check current count) + `ZADD` (add new entry) must all run together. Without atomicity, two requests could both see `count = limit - 1` and both add themselves, leaving `count = limit + 1`. |
| **Leaky Bucket** | Same as Token Bucket — the leak calculation and the queue increment must be one atomic operation. |

The Lua scripts for these three algorithms are documented in `docs/Algorithms.md`.

---

## 6. Redis Connection Failure — Fail-Open

### The Choice

When the Node.js server cannot reach Redis (network partition, Redis crash, timeout), there are two possible behaviours:

- **Fail-closed:** Reject all requests with HTTP 503 Service Unavailable until Redis recovers.
- **Fail-open:** Allow all requests through without rate limiting until Redis recovers.

**RateShield chooses fail-open.**

### Why Fail-Open?

The decision comes down to what matters more: **availability** or **strict rate limiting correctness**.

For RateShield's use case — protecting an API that serves developers and businesses — availability is the higher priority:

**1. Redis downtime is rare and brief.**  
In a well-operated system, Redis connection failures are momentary (seconds, not minutes). During those seconds, the cost of allowing a few extra requests is low.

**2. Fail-closed breaks the API entirely.**  
A rate limiter is infrastructure — it should be invisible on the happy path. If Redis goes down and suddenly every request returns 503, the API appears completely broken to all clients. That is worse than a brief unprotected window.

**3. Abuse during a brief outage is limited.**  
An attacker would need to know exactly when Redis is unreachable and exploit that window. In practice, Redis instability is not reliably predictable from outside the system.

**4. Observability mitigates the risk.**  
When a Redis failure occurs, the connection error is logged immediately with full context (Winston), and a Prometheus counter (`rateshield_redis_errors_total`) fires. On-call engineers are alerted within seconds.

### What Fail-Open Looks Like in Practice

```
Normal request:
  -> Connect to Redis
  -> Execute Lua script
  -> Return { allowed: true/false }

Redis unreachable request:
  -> Connect to Redis
  -> Connection timeout or error
  -> Log: { level: "error", event: "redis_failure", msg: "allowing request (fail-open)" }
  -> Increment Prometheus counter: rateshield_redis_errors_total
  -> Return { allowed: true }   <- pass the request through
  -> Route handler executes normally
```

### When Would You Choose Fail-Closed?

Fail-closed is the right choice for:
- **Financial APIs** where a brief over-limit window causes real monetary harm.
- **Systems where the rate limiter is the primary security control** (not just one layer of many).
- **Known abuse patterns** where the attacker is sophisticated enough to exploit outages.

For RateShield (a learning project and general-purpose middleware), fail-open is the correct default. The behaviour should be a **configurable environment variable** (`RATE_LIMIT_FAILURE_MODE=open|closed`) so adopters can choose the behaviour that fits their risk tolerance. For v1, a single global setting is sufficient — per-policy failure modes add unnecessary complexity.

---

## 7. Memory Footprint Estimate

### Why This Matters

Redis stores everything in RAM. RAM is expensive in production. Before writing a single line of code, it is worth knowing whether the design will fit in memory at realistic scale.

### Per-Key Size Estimates

Each number below is an estimate based on Redis's internal encoding. Redis uses compact encodings for small integers and short strings.

Redis also has a per-key overhead of approximately **50–60 bytes** for its internal dictionary entry and TTL bookkeeping, added to every key regardless of type.

| Algorithm | Key Size | Value Size | Redis Overhead | Total Per Key |
|---|---|---|---|---|
| **Fixed Window** | ~65 bytes | ~8 bytes (integer string) | ~55 bytes | **~130 bytes** |
| **Sliding Window** | ~70 bytes (×2 for two window keys) | ~8 bytes each | ~55 bytes each | **~266 bytes total** |
| **Sliding Log** | ~70 bytes | ~50 bytes per log entry × N requests | ~55 bytes | **~125 + 50×N bytes** |
| **Token Bucket** | ~75 bytes | ~40 bytes (hash, 2 fields) | ~55 bytes | **~170 bytes** |
| **Leaky Bucket** | ~75 bytes | ~40 bytes (hash, 2 fields) | ~55 bytes | **~170 bytes** |

### Scenario: 100,000 Active Users

**Assumptions:**
- "Active" means the user made at least one request in the current TTL window.
- Each user is rate-limited on an average of **3 endpoints** (e.g., `/api/data`, `/auth/refresh`, `/api/submit`).
- For Sliding Log: peak of 50 requests per user per window (memory worst case).

**Token Bucket (representative middle-ground):**

```
Per key:     ~170 bytes
Users:       100,000
Endpoints:   3 per user
Total keys:  300,000

Memory = 300,000 * 170 bytes = 51,000,000 bytes = ~49 MB
```

**Sliding Log (worst case at 50 req/window per user):**

```
Per key (base):    ~125 bytes
Per log entry:     ~50 bytes * 50 requests = 2,500 bytes
Total per key:     ~2,625 bytes

Users:       100,000
Endpoints:   3 per user
Total keys:  300,000

Memory = 300,000 * 2,625 bytes = 787,500,000 bytes = ~751 MB
```

### Summary Table

| Algorithm | Keys (100K users * 3 endpoints) | Approx RAM |
|---|---|---|
| Fixed Window | 300,000 keys * ~130 bytes | **~37 MB** |
| Sliding Window | 600,000 keys * ~133 bytes | **~76 MB** |
| Sliding Log | 300,000 keys * ~2,625 bytes | **~751 MB** (at 50 req/window) |
| Token Bucket | 300,000 keys * ~170 bytes | **~49 MB** |
| Leaky Bucket | 300,000 keys * ~170 bytes | **~49 MB** |

### Interpretation

- **Fixed Window, Token Bucket, Leaky Bucket** are all highly memory-efficient. Even at 1 million users across 3 endpoints, you are looking at under 500 MB — fits comfortably on a 1 GB Redis instance.
- **Sliding Window** doubles Fixed Window's key count but is still compact.
- **Sliding Log** is the outlier. Its memory cost scales with the number of requests in the window, not just the number of users. At high traffic rates, this can become significant. This is why Sliding Log is better suited for **low-traffic, high-precision** use cases (e.g., login attempts, password resets) rather than high-volume general endpoints.

**Redis default max memory:** `maxmemory` is typically configured to 512 MB – 2 GB in production. For v1 (development / Docker Compose), 256 MB is more than sufficient for all five algorithms at the target 1,000 concurrent request scale.

---

## 8. Open Questions and Decisions

The following points were not fully specified in the PRD and require a decision before implementation begins. These are not blockers — sensible defaults are suggested — but they should be confirmed before coding the relevant modules.

| # | Question | Recommended Default | Impact |
|---|---|---|---|
| **Q1** | What is the default window size for Fixed Window if a policy does not specify one? | 60 seconds | Needs to be a named constant in the codebase |
| **Q2** | What is the default token refill rate for Token Bucket if not specified in a policy? | `limit / windowSize` (e.g., 100 req/min → 1.67 tokens/sec) | Must be derivable from the existing policy fields without adding a new DB column |
| **Q3** | Should `RATE_LIMIT_FAILURE_MODE` (fail-open vs fail-closed) be a global env var or per-policy? | Global env var for v1 | Per-policy adds a new column to the `policies` table and a policy model change — defer to v2 |
| **Q4** | For Sliding Log, what is the grace TTL added beyond the window size? | 2x the window size (e.g., 60s window → 120s grace → 180s total TTL) | Prevents premature key deletion during burst-then-quiet traffic patterns |
| **Q5** | For Token Bucket / Leaky Bucket, what is the idle TTL before a bucket is deleted? | 24 hours | Balances memory efficiency (idle users cleaned up) vs. session continuity (active users keep their state) |
| **Q6** | For Leaky Bucket, what is the leak rate — is it configurable per policy, or derived from limit/window? | Configurable per policy (stored in the `policies` table as `leakRate`) | Requires a DB column; if not added, it must be derived and the two algorithms become functionally similar |

---

*Related documents:*
- [`docs/Architecture.md`](./Architecture.md) — Why Redis, system overview, and Architectural Decisions
- [`docs/Algorithms.md`](./Algorithms.md) — Each algorithm explained with diagrams and the full Lua pseudocode
- [`docs/Database.md`](./Database.md) — PostgreSQL schema (users, policies, audit logs)
