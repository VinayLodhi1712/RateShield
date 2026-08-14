# Algorithms — RateShield

**Version:** 1.0  
**Date:** 2026-07-30  
**Author:** Vinay Anand Lodhi  
**Status:** Draft — pending review

---

## Table of Contents

1. [What This Document Covers](#1-what-this-document-covers)
2. [The Shared Worked Example](#2-the-shared-worked-example)
3. [Algorithm 1: Fixed Window](#3-algorithm-1-fixed-window)
4. [Algorithm 2: Sliding Window](#4-algorithm-2-sliding-window)
5. [Algorithm 3: Sliding Log](#5-algorithm-3-sliding-log)
6. [Algorithm 4: Token Bucket](#6-algorithm-4-token-bucket)
7. [Algorithm 5: Leaky Bucket](#7-algorithm-5-leaky-bucket)
8. [Comparison Table](#8-comparison-table)
9. [Which Algorithm for Which Endpoint?](#9-which-algorithm-for-which-endpoint)
10. [Lua Script Cross-Reference](#10-lua-script-cross-reference)

---

## 1. What This Document Covers

`Redis.md` explained how Redis stores rate limit state and why Lua scripts are needed for atomicity. It also provided the full Lua pseudocode for **Fixed Window** and **Token Bucket**.

This document covers all five algorithms in depth:

- Plain-English explanation with an analogy
- A worked numeric example using the **same 10-request scenario** across all five algorithms, so you can directly compare how they behave differently on identical traffic
- Full Lua pseudocode for **Sliding Window**, **Sliding Log**, and **Leaky Bucket** (the three not covered in Redis.md)
- Trade-off analysis and real-world applicability

After reading this document you should be able to:
- Explain the intuition behind each algorithm in a job interview
- Understand why the same traffic pattern produces different allow/block decisions depending on the algorithm
- Choose the right algorithm for a given API endpoint's requirements

This document does not contain Node.js code. Implementation lives in `backend/src/limiters/`.

---

## 2. The Shared Worked Example

To make the comparison concrete, every algorithm in this document is evaluated against the **same sequence of 10 requests** arriving at irregular intervals.

### Setup

- **Limit:** 5 requests per 60-second window
- **User:** `user:123`
- **Endpoint:** `POST /auth/login`

### Request Timeline

All timestamps are seconds from the start (second 0 = beginning of the window).

```
Request #   Timestamp (s)   Notes
---------   -------------   -----
R1          0               First request, window just started
R2          5               5 seconds after start
R3          10              10 seconds after start
R4          15              15 seconds after start
R5          20              5th request — at or near the limit
R6          25              Burst continues — should start being blocked
R7          30              30 seconds in — halfway through window
R8          61              1 second into the NEXT window
R9          65              5 seconds into the next window
R10         70              10 seconds into the next window
```

The key thing to watch: **how does each algorithm treat R6 and R7** (the 6th and 7th requests in the same burst)? And **how does each algorithm treat R8** (the first request of the new window)?

---

## 3. Algorithm 1: Fixed Window

### Plain-English Explanation

Imagine a **turnstile counter at a museum**. The museum allows 5 visitors per hour. The counter resets to zero at the start of every hour, regardless of when visitors arrived within that hour.

Fixed Window works the same way:
- Time is divided into fixed, non-overlapping windows (e.g., each minute from :00 to :59)
- A counter tracks how many requests arrived in the current window
- When the window ends, the counter resets to zero automatically (the Redis key expires)
- If the counter reaches the limit before the window ends, all subsequent requests in that window are blocked

### Redis Data Structure

A single string key per (user, endpoint, window-start-timestamp):

```
rateshield:fixed:user:123:POST:%2Fauth%2Flogin:1722345600
value: "3"   <- integer counter
```

### Lua Script Logic

> Full pseudocode is in `Redis.md Section 5 — Fixed Window`. Summarised here for reference:

```
1. GET the counter for this key.
2. If key doesn't exist: SET to 1 with TTL = windowSeconds + 1. Return allowed.
3. If counter >= limit: Return blocked.
4. INCR counter. Return allowed.
```

### Worked Example

Window size: 60 seconds. Window 1 starts at t=0, Window 2 starts at t=60.

```
R1  t=0s   counter=1  (window 1, key created)        ALLOWED  remaining=4
R2  t=5s   counter=2                                  ALLOWED  remaining=3
R3  t=10s  counter=3                                  ALLOWED  remaining=2
R4  t=15s  counter=4                                  ALLOWED  remaining=1
R5  t=20s  counter=5  (at limit)                      ALLOWED  remaining=0
R6  t=25s  counter=5  (limit already reached)         BLOCKED
R7  t=30s  counter=5  (still in window 1)             BLOCKED
                      Key expires at t=61
R8  t=61s  counter=1  (window 2, fresh key created)   ALLOWED  remaining=4
R9  t=65s  counter=2                                  ALLOWED  remaining=3
R10 t=70s  counter=3                                  ALLOWED  remaining=2
```

**Result: 8 allowed, 2 blocked (R6 and R7).**

### The Boundary Burst Problem

Fixed Window has a well-known weakness: a client can send **double the limit** at a window boundary.

```
Window 1  (t=0 to t=60):
  t=55s: 5 requests arrive → all allowed (fills the window)

Window 2  (t=60 to t=120):
  t=61s: 5 requests arrive → all allowed (fresh counter)

Result: 10 requests in the 10-second span from t=55 to t=65.
        The stated limit was 5 per 60 seconds. Effective rate: 10x over 10s.
```

This is the "boundary burst" or "thundering herd at window rollover" problem. It does not violate the counter for either window individually, but it does violate the spirit of the rate limit. Sliding Window and Sliding Log both solve this.

### When to Use Fixed Window

- **Suitable for:** Coarse, non-security-critical limits where simplicity and performance matter most.
- **Example:** General API usage quota — "developers get 10,000 API calls per day". Precise enforcement at the day boundary is less critical than tracking a broad daily budget.
- **Not suitable for:** Security-sensitive endpoints where the boundary burst could be exploited.

---

## 4. Algorithm 2: Sliding Window

### Plain-English Explanation

Sliding Window is an **approximation fix** for the Fixed Window boundary burst problem — without the full memory cost of the Sliding Log.

Instead of forgetting the previous window entirely, it borrows a weighted portion of it:

> **Analogy:** You are counting cars on a road over any rolling 60-minute period. You don't have a log of every car, but you do know: "In the previous full hour, 3 cars passed. We are now 30 seconds into the current hour (halfway), so we estimate that about 1.5 of those previous-hour cars would fall in our rolling window." You add that estimate to the current hour's count to get a blended total.

The formula:

```
overlap_fraction = time elapsed in current window / window size
blended_count = (previous_window_count × (1 - overlap_fraction)) + current_window_count
```

If `blended_count < limit`, the request is allowed.

### Redis Data Structure

Two string keys: one for the current window, one for the previous window.

```
rateshield:sliding_window:user:123:POST:%2Fauth%2Flogin:1722345600  <- current
rateshield:sliding_window:user:123:POST:%2Fauth%2Flogin:1722345540  <- previous (60s earlier)
```

Both hold plain integer counters. Only the current window counter is ever incremented; the previous is read-only.

### Lua Script Logic (Full Pseudocode)

**Inputs:**
- `CURR_KEY`: Redis key for the current window
- `PREV_KEY`: Redis key for the previous window
- `LIMIT`: maximum requests
- `WINDOW_SECONDS`: window size in seconds
- `NOW`: current Unix timestamp in seconds
- `WINDOW_START`: floor of `NOW / WINDOW_SECONDS * WINDOW_SECONDS` (start of current window)

```
1. GET current_count from CURR_KEY.
   If CURR_KEY does not exist: current_count = 0

2. GET prev_count from PREV_KEY.
   If PREV_KEY does not exist: prev_count = 0

3. Calculate how far we are through the current window:
   elapsed_in_window = NOW - WINDOW_START        (seconds since this window began)
   overlap_fraction  = elapsed_in_window / WINDOW_SECONDS
                       (ranges from 0.0 at window start to ~1.0 at window end)

4. Calculate the blended count:
   blended = (prev_count * (1 - overlap_fraction)) + current_count

   Intuition: if we are 30s into a 60s window (overlap_fraction = 0.5),
   we count half of the previous window's requests as still "recent".

5. If blended >= LIMIT:
   Return { allowed: false, remaining: 0 }

6. If blended < LIMIT:
   INCR CURR_KEY by 1
   If CURR_KEY was just created (didn't exist at step 1):
     SET TTL of CURR_KEY to (WINDOW_SECONDS * 2 + 1)
     (must survive long enough to be the "previous" window for the next window)
   Return { allowed: true, remaining: floor(LIMIT - blended - 1) }
```

> **Note on atomicity:** Steps 1–6 run as a single Lua script on Redis. Without atomicity, two concurrent requests could both read `blended = 4` (under a limit of 5), both decide to allow, and both increment — leaving `blended = 6`, exceeding the limit. See `Redis.md Section 5` for the race condition explanation.

### Worked Example

Same 10 requests, limit = 5, window = 60s.

Window 1 starts at t=0. Window 2 starts at t=60.

```
R1  t=0s
    prev=0, curr=0, elapsed=0s, overlap=0.0
    blended = 0*(1-0.0) + 0 = 0  < 5   ALLOWED   curr becomes 1

R2  t=5s
    prev=0, curr=1, elapsed=5s, overlap=0.083
    blended = 0*0.917 + 1 = 1.0  < 5   ALLOWED   curr becomes 2

R3  t=10s
    blended = 0*0.833 + 2 = 2.0  < 5   ALLOWED   curr becomes 3

R4  t=15s
    blended = 0*0.75 + 3 = 3.0   < 5   ALLOWED   curr becomes 4

R5  t=20s
    blended = 0*0.667 + 4 = 4.0  < 5   ALLOWED   curr becomes 5

R6  t=25s
    blended = 0*0.583 + 5 = 5.0  >= 5  BLOCKED

R7  t=30s
    blended = 0*0.5 + 5 = 5.0    >= 5  BLOCKED

-- Window 2 starts at t=60. prev = window1 counter = 5, curr = 0 --

R8  t=61s
    prev=5, curr=0, elapsed=1s, overlap=0.017
    blended = 5*(1-0.017) + 0 = 5*0.983 = 4.92  < 5   ALLOWED   curr becomes 1

    Why? Only 1 second into the new window, 98.3% of the previous window's
    requests still "count" in our rolling estimate. 4.92 is just under 5.

R9  t=65s
    prev=5, curr=1, elapsed=5s, overlap=0.083
    blended = 5*0.917 + 1 = 4.58 + 1 = 5.58  >= 5  BLOCKED

    R8 incremented the current counter to 1. Now the blended count exceeds 5.

R10 t=70s
    prev=5, curr=1, elapsed=10s, overlap=0.167
    blended = 5*0.833 + 1 = 4.17 + 1 = 5.17  >= 5  BLOCKED
```

**Result: 6 allowed, 4 blocked (R6, R7, R9, R10).**

Notice that R8 was allowed at t=61 — but R9 at t=65 was blocked because the previous window's count still weighs heavily. Sliding Window prevents the boundary burst that Fixed Window allows. The client cannot send 5+5=10 requests across the boundary — they will be throttled.

### Accuracy Note

Sliding Window is an **approximation**. It assumes requests were uniformly distributed across the previous window. If all 5 previous-window requests arrived at t=59 (1 second before the window ended), the algorithm will undercount them at t=61, potentially allowing a small burst it should not. This inaccuracy is the price paid for not storing individual timestamps (which Sliding Log does). For most use cases the approximation is accurate enough.

### When to Use Sliding Window

- **Suitable for:** Medium-sensitivity endpoints where the boundary burst problem matters but exact precision is not required. A good balance of accuracy, memory efficiency, and implementation simplicity.
- **Example:** Per-user request quotas on a general API (`GET /api/data`) — prevents boundary bursting without the memory overhead of Sliding Log.
- **Not suitable for:** High-security endpoints (use Sliding Log) or bursty-by-design APIs (use Token Bucket).

---

## 5. Algorithm 3: Sliding Log

### Plain-English Explanation

Sliding Log is the **most accurate** of the five algorithms. It does not approximate — it keeps a literal timestamp log of every request in the window.

> **Analogy:** A security guard at a club keeps a physical logbook. Every person who enters gets their entry time written down. Before letting someone in, the guard flips back through the logbook and crosses out every entry older than 60 minutes — then counts the remaining entries. If there are 5 or more names still in the uncrossed section, the club is "full" and the next person is turned away.

The logbook is Redis's sorted set. Each "name" is a unique request ID. Each entry's "time" is the score (Unix timestamp in milliseconds). Crossing out old entries is `ZREMRANGEBYSCORE`. Counting remaining entries is `ZCOUNT`.

### Redis Data Structure

A sorted set — one key per (user, endpoint):

```
rateshield:sliding_log:user:123:POST:%2Fauth%2Flogin
```

Members are unique request identifiers (UUIDs); scores are timestamps in milliseconds:

```
Score (timestamp ms)    Member
1722345600000           "req-uuid-001"
1722345605000           "req-uuid-002"
1722345610000           "req-uuid-003"
1722345615000           "req-uuid-004"
1722345620000           "req-uuid-005"
```

### Lua Script Logic (Full Pseudocode)

**Inputs:**
- `KEY`: the sorted set key
- `LIMIT`: maximum requests
- `WINDOW_MS`: window size in milliseconds (e.g., 60000 for 60s)
- `NOW_MS`: current timestamp in milliseconds
- `REQUEST_ID`: a unique string for this request (e.g., UUID)
- `TTL_SECONDS`: key TTL = `WINDOW_MS/1000 * 3` (3× the window, see `Redis.md Q4`)

```
1. Remove all entries older than the window:
   ZREMRANGEBYSCORE KEY 0 (NOW_MS - WINDOW_MS)

   This prunes all timestamps older than 60 seconds ago.
   After this step, the sorted set contains only requests in the rolling window.

2. Count remaining entries:
   count = ZCARD KEY   (or ZCOUNT KEY -inf +inf)

3. If count >= LIMIT:
   EXPIRE KEY TTL_SECONDS   (refresh TTL even on a blocked request)
   Return { allowed: false, remaining: 0 }

4. If count < LIMIT:
   Add this request to the log:
   ZADD KEY NOW_MS REQUEST_ID

   Update TTL:
   EXPIRE KEY TTL_SECONDS

   Return { allowed: true, remaining: LIMIT - count - 1 }
```

> **Why `ZREMRANGEBYSCORE` before `ZCARD`?** If we count first, we include stale entries (older than 60s) in the count, which would block requests that should be allowed. We must prune before counting.

> **Atomicity:** All four steps run as one Lua script. Without atomicity: two requests could both call `ZCARD`, both get `count = 4`, both decide to allow, both call `ZADD` — leaving 6 entries. The limit was 5. See `Redis.md Section 5`.

### Worked Example

Same 10 requests, limit = 5, window = 60,000ms.

```
R1  t=0s    (t=0ms)
    Prune: nothing to remove
    ZCARD = 0 < 5   ALLOWED   ZADD 0ms "req-001"
    Set = { req-001:0 }

R2  t=5s    (t=5000ms)
    Prune: remove entries < (5000-60000) = -55000ms → nothing removed
    ZCARD = 1 < 5   ALLOWED   ZADD 5000ms "req-002"
    Set = { req-001:0, req-002:5000 }

R3  t=10s   ZCARD=2  ALLOWED   Set size: 3
R4  t=15s   ZCARD=3  ALLOWED   Set size: 4
R5  t=20s   ZCARD=4  ALLOWED   Set size: 5

R6  t=25s   (t=25000ms)
    Prune: remove < (25000-60000) = -35000ms → nothing removed
    ZCARD = 5 >= 5   BLOCKED   (set not modified)

R7  t=30s   (t=30000ms)
    Prune: remove < -30000ms → nothing removed
    ZCARD = 5 >= 5   BLOCKED

R8  t=61s   (t=61000ms)
    Prune: remove entries with score < (61000-60000) = 1ms
           → removes req-001 (score=0ms, which is < 1ms)
    ZCARD after prune = 4 < 5   ALLOWED   ZADD 61000ms "req-008"
    Set = { req-002:5000, req-003:10000, req-004:15000, req-005:20000, req-008:61000 }

R9  t=65s   (t=65000ms)
    Prune: remove entries < (65000-60000) = 5000ms
           → removes req-002 (score=5000, which is NOT < 5000 — boundary exact)
           Actually: < 5000 is exclusive, so req-002 (score=5000) survives.
    ZCARD = 5 >= 5   BLOCKED

R10 t=70s   (t=70000ms)
    Prune: remove entries < (70000-60000) = 10000ms
           → removes req-002 (score=5000 < 10000) and req-003 (score=10000? boundary)
           Using strict <: req-002 removed, req-003 (10000) stays.
    ZCARD after prune = 4 < 5   ALLOWED
    Set = { req-003:10000, req-004:15000, req-005:20000, req-008:61000, req-010:70000 }
```

**Result: 8 allowed (R1–R5, R8, R10 — and a borderline R9 blocked), 2–3 blocked depending on exact boundary semantics.**

The key insight: **Sliding Log enforces a true rolling window**. At t=61s, R1 (from t=0s) is evicted from the window, making room for R8. There is no boundary burst possible: you can never fit more than 5 requests in any 60-second span.

### Memory Trade-off

The sorted set grows with every allowed request. For a limit of 5 req/min, the set never exceeds 5 members. But for a limit of 10,000 req/hour on a high-traffic endpoint, the set can hold up to 10,000 members. This is why Sliding Log is recommended for **low-volume, high-precision** use cases. See `Redis.md Section 7` for memory estimates.

### When to Use Sliding Log

- **Suitable for:** Security-critical, low-volume endpoints where exact accuracy matters more than memory efficiency.
- **Example:** `POST /auth/login` — 5 attempts per minute per IP. With Sliding Log, there is provably no way to attempt more than 5 logins in any 60-second window.
- **Not suitable for:** High-traffic endpoints (memory cost), or anywhere burst tolerance is needed (Token Bucket).

---

## 6. Algorithm 4: Token Bucket

### Plain-English Explanation

Token Bucket is the most **burst-friendly** algorithm — the one that best mimics how real traffic naturally behaves.

> **Analogy:** You have a bucket that holds up to 100 tokens. Tokens drip into the bucket at a steady rate — say, 10 tokens per second. Each API request consumes 1 token. If you make a request and the bucket has at least 1 token, the request is allowed and one token is removed. If the bucket is empty, the request is blocked. If you don't make any requests for a while, tokens accumulate (up to the bucket's capacity). When you come back, you have a reserve of tokens to spend on a burst.

The key behaviours:
- **Bursts are allowed** up to the bucket capacity. A user who has been idle can immediately fire 100 requests.
- **Sustained rate is limited** by the refill rate (10 tokens/sec = 600 req/min).
- **The bucket never overflows** — once full, new tokens are discarded.

### Redis Data Structure

A hash key with two fields:

```
rateshield:token_bucket:user:123:GET:%2Fapi%2Fdata
  tokens:     "847.5"          <- current token count (float)
  lastRefill: "1722345612345"  <- Unix timestamp in ms of last refill
```

### Lua Script Logic

> Full pseudocode is in `Redis.md Section 5 — Token Bucket`. Summarised here for reference:

```
1. HGETALL key -> get {tokens, lastRefill}
2. If key missing: tokens = CAPACITY, lastRefill = NOW_MS
3. If key exists:
   elapsed = (NOW_MS - lastRefill) / 1000
   tokens = min(tokens + elapsed * REFILL_RATE, CAPACITY)
   lastRefill = NOW_MS
4. If tokens < 1: write back state, return blocked
5. If tokens >= 1: tokens -= 1, write back state, return allowed
```

### Worked Example

Capacity = 5 tokens, refill rate = 5/60 tokens per second ≈ 0.0833 tokens/sec (equivalent to 5 req/min steady-state). Bucket starts full (5 tokens).

```
R1  t=0s
    elapsed=0s, tokens_added=0, tokens=5.0
    tokens >= 1: ALLOWED   tokens = 4.0

R2  t=5s
    elapsed=5s, tokens_added=5*0.0833=0.417, tokens=4.0+0.417=4.417
    tokens >= 1: ALLOWED   tokens = 3.417

R3  t=10s
    elapsed=5s, added=0.417, tokens=3.417+0.417=3.833
    ALLOWED   tokens = 2.833

R4  t=15s
    elapsed=5s, added=0.417, tokens=2.833+0.417=3.25
    ALLOWED   tokens = 2.25

R5  t=20s
    elapsed=5s, added=0.417, tokens=2.25+0.417=2.667
    ALLOWED   tokens = 1.667

R6  t=25s
    elapsed=5s, added=0.417, tokens=1.667+0.417=2.083
    ALLOWED   tokens = 1.083   <- still tokens available! Burst continues.

R7  t=30s
    elapsed=5s, added=0.417, tokens=1.083+0.417=1.5
    ALLOWED   tokens = 0.5

    (At this point the bucket has 0.5 tokens — not enough for one full request)

R8  t=61s
    elapsed=31s, added=31*0.0833=2.583, tokens=0.5+2.583=3.083
    tokens >= 1: ALLOWED   tokens = 2.083

R9  t=65s
    elapsed=4s, added=0.333, tokens=2.083+0.333=2.417
    ALLOWED   tokens = 1.417

R10 t=70s
    elapsed=5s, added=0.417, tokens=1.417+0.417=1.833
    ALLOWED   tokens = 0.833
```

**Result: All 10 requests ALLOWED.**

This demonstrates Token Bucket's burst tolerance. With a Fixed Window or Sliding Log limit of 5 req/60s, R6 and R7 would be blocked. Token Bucket allows them because:
1. The bucket started full (5 tokens).
2. Tokens refilled between requests.
3. The burst was absorbed by the token reserve.

The steady-state rate is still 5 req/min. But the algorithm distributes the allowed traffic more smoothly and generously than window-based approaches.

**What would have been blocked?** If requests arrived faster than 1 every 12 seconds (the steady refill rate), the bucket would eventually drain. With requests every 5 seconds, the bucket drains over time. A burst of 10 requests all at t=0 would consume all 5 tokens immediately, then 5 more would be blocked.

### When to Use Token Bucket

- **Suitable for:** High-traffic, bursty, user-facing APIs where blocking brief bursts would feel punishing to legitimate users.
- **Example:** `GET /api/data` — a read endpoint that developers query frequently. They deserve to burst during a debugging session, as long as their sustained rate stays within limits.
- **Not suitable for:** Security-critical endpoints where burst tolerance is a liability (login, registration).

---

## 7. Algorithm 5: Leaky Bucket

### Plain-English Explanation

Leaky Bucket models a **queue with a fixed processing rate**, not a token reserve. Think of it as the inverse of Token Bucket.

> **Analogy:** A water barrel with a hole in the bottom. Water drips out at a steady, constant rate — 1 drop per second. You can pour water in at any rate, but the barrel has a maximum capacity. If it is full, new water overflows and is discarded. The barrel processes water at its own pace regardless of how fast you pour.

The key difference from Token Bucket:
- **Token Bucket:** you accumulate credit during quiet periods and can spend it in a burst.
- **Leaky Bucket:** the processing rate is fixed. Bursts are queued up to capacity, then rejected. There is no burst reserve.

In RateShield's implementation, the "barrel" is virtual — we do not actually queue requests. Instead, we compute how many requests would have "drained" since the last check, and use that to determine how much room remains in the queue.

### Redis Data Structure

A hash key with two fields:

```
rateshield:leaky_bucket:user:123:POST:%2Fapi%2Fsubmit
  queue:    "3"              <- current items in the virtual queue
  lastLeak: "1722345612345" <- Unix timestamp in ms of last drain calculation
```

The `queue` field represents how full the bucket is right now. When `queue = capacity`, the next request overflows (is rejected).

### Lua Script Logic (Full Pseudocode)

**Inputs:**
- `KEY`: the hash key
- `CAPACITY`: maximum queue size (from `policies.limit_count`)
- `LEAK_RATE`: requests leaked (processed) per second (from `policies.leak_rate_per_second`, or derived as `limit_count / window_seconds`)
- `NOW_MS`: current timestamp in milliseconds
- `TTL_SECONDS`: idle TTL, 86400 (24 hours) — see `Redis.md Q5`

```
1. HGETALL KEY -> get {queue, lastLeak}

2. If KEY does not exist:
   queue    = 0           <- empty bucket on first request
   lastLeak = NOW_MS

3. If KEY exists:
   elapsed_seconds = (NOW_MS - lastLeak) / 1000

   drained = elapsed_seconds * LEAK_RATE
              <- how many items would have leaked out since last check

   queue = max(queue - drained, 0)
            <- subtract drained items; can't go below 0 (bucket can't go negative)

   lastLeak = NOW_MS    <- update the drain timestamp

4. If queue >= CAPACITY:
   Write back { queue, lastLeak }
   EXPIRE KEY TTL_SECONDS
   Return { allowed: false, remaining: 0 }

5. If queue < CAPACITY:
   queue = queue + 1    <- add this request to the queue
   Write back { queue: queue, lastLeak: NOW_MS }
   EXPIRE KEY TTL_SECONDS
   Return { allowed: true, remaining: floor(CAPACITY - queue) }
```

> **Why `max(queue - drained, 0)`?** Without the `max`, a long idle period could produce a negative queue value. A negative queue has no meaning — the bucket is simply empty. Clamping to 0 prevents this.

### Worked Example

Capacity = 5 queue slots, leak rate = 5/60 ≈ 0.0833 items per second. Bucket starts empty.

```
R1  t=0s
    lastLeak=0, elapsed=0s, drained=0, queue=0
    queue < capacity(5): ALLOWED   queue = 0+1 = 1

R2  t=5s
    elapsed=5s, drained=5*0.0833=0.417, queue=max(1-0.417,0)=0.583
    queue(0.583) < 5: ALLOWED   queue = 0.583+1 = 1.583

R3  t=10s
    elapsed=5s, drained=0.417, queue=max(1.583-0.417,0)=1.167
    ALLOWED   queue = 1.167+1 = 2.167

R4  t=15s
    elapsed=5s, drained=0.417, queue=max(2.167-0.417,0)=1.75
    ALLOWED   queue = 1.75+1 = 2.75

R5  t=20s
    elapsed=5s, drained=0.417, queue=max(2.75-0.417,0)=2.333
    ALLOWED   queue = 2.333+1 = 3.333

R6  t=25s
    elapsed=5s, drained=0.417, queue=max(3.333-0.417,0)=2.917
    ALLOWED   queue = 2.917+1 = 3.917

R7  t=30s
    elapsed=5s, drained=0.417, queue=max(3.917-0.417,0)=3.5
    ALLOWED   queue = 3.5+1 = 4.5

    (Bucket is filling up — 4.5 out of 5 slots used)

R8  t=61s
    elapsed=31s, drained=31*0.0833=2.583, queue=max(4.5-2.583,0)=1.917
    ALLOWED   queue = 1.917+1 = 2.917

R9  t=65s
    elapsed=4s, drained=4*0.0833=0.333, queue=max(2.917-0.333,0)=2.583
    ALLOWED   queue = 2.583+1 = 3.583

R10 t=70s
    elapsed=5s, drained=0.417, queue=max(3.583-0.417,0)=3.167
    ALLOWED   queue = 3.167+1 = 4.167
```

**Result: All 10 requests ALLOWED** — same as Token Bucket for this traffic pattern.

**When does Leaky Bucket block?** When requests arrive so fast that the queue fills up before enough time has passed to drain it. Example: 6 requests all at t=0:
- R1-R5: queue fills to 5 (capacity)
- R6: queue = 5 >= capacity → **BLOCKED**

The critical difference vs. Token Bucket: in Leaky Bucket, if you send a burst of 5 requests all at once (t=0), you fill the queue immediately and the 6th is rejected — even though you had been idle before. In Token Bucket, prior idle time fills your token reserve, so a burst after idle time is allowed. Leaky Bucket does not reward prior idleness.

### When to Use Leaky Bucket

- **Suitable for:** APIs where you need to enforce a **smooth, constant output rate** and protect downstream services from bursts. Good for write endpoints or operations that trigger expensive downstream work.
- **Example:** `POST /api/submit` — a job submission endpoint that triggers a background worker. The worker can only handle jobs at a fixed rate. Leaky Bucket ensures the job queue does not get overwhelmed.
- **Not suitable for:** Read APIs where burst tolerance is desirable (Token Bucket), or security endpoints (Sliding Log).

---

## 8. Comparison Table

### Core Trade-offs

| Attribute | Fixed Window | Sliding Window | Sliding Log | Token Bucket | Leaky Bucket |
|---|---|---|---|---|---|
| **Accuracy** | Low — boundary burst possible | Medium — approximation, not exact | High — exact rolling window | Medium — allows burst, but rate is correct | Medium — smooth rate, queue-based |
| **Memory per user** | Tiny (~130 bytes) | Small (~266 bytes, 2 keys) | Variable (~125 + 50×N bytes) | Small (~170 bytes) | Small (~170 bytes) |
| **Burst tolerance** | None after limit hit | Low | None | High | Low |
| **Handles idle periods** | Yes — counter resets | Yes — counter resets | Yes — old entries pruned | Yes — tokens accumulate | No — bucket doesn't pre-fill |
| **Redis data type** | String (counter) | String × 2 | Sorted Set | Hash | Hash |
| **Algorithm complexity** | Very simple | Simple | Moderate | Moderate | Moderate |
| **Lua script complexity** | Simple | Simple | Moderate | Moderate | Moderate |

### Behaviour Comparison: 10 Requests, Same Timeline

| Request | t (s) | Fixed Window | Sliding Window | Sliding Log | Token Bucket | Leaky Bucket |
|---|---|---|---|---|---|---|
| R1 | 0 | ✅ | ✅ | ✅ | ✅ | ✅ |
| R2 | 5 | ✅ | ✅ | ✅ | ✅ | ✅ |
| R3 | 10 | ✅ | ✅ | ✅ | ✅ | ✅ |
| R4 | 15 | ✅ | ✅ | ✅ | ✅ | ✅ |
| R5 | 20 | ✅ | ✅ | ✅ | ✅ | ✅ |
| R6 | 25 | ❌ | ❌ | ❌ | ✅ | ✅ |
| R7 | 30 | ❌ | ❌ | ❌ | ✅ | ✅ |
| R8 | 61 | ✅ | ✅ | ✅ | ✅ | ✅ |
| R9 | 65 | ✅ | ❌ | ❌ | ✅ | ✅ |
| R10 | 70 | ✅ | ❌ | ✅ | ✅ | ✅ |
| **Total allowed** | | **8** | **6** | **7** | **10** | **10** |

> **Why does Fixed Window allow 8 but Sliding Window only 6?** Because at t=61s (start of window 2), Fixed Window resets to 0 immediately — R8, R9, R10 all get through. Sliding Window still "remembers" the previous window's count (5) and blends it in, blocking R9 and R10 because the blended estimate is still near the limit.

### Security vs. Latency vs. Memory

| Dimension | Best Choice | Worst Choice |
|---|---|---|
| Security (brute-force protection) | Sliding Log | Fixed Window |
| Burst tolerance (user experience) | Token Bucket | Sliding Log |
| Memory efficiency | Fixed Window | Sliding Log (at high volumes) |
| Implementation simplicity | Fixed Window | Sliding Log |
| Smooth output rate enforcement | Leaky Bucket | Fixed Window |

---

## 9. Which Algorithm for Which Endpoint?

This section maps each algorithm to real-world endpoint types with concrete reasoning.

### Login / Registration — Sliding Log

```
POST /auth/login
POST /auth/register
POST /auth/reset-password
```

**Why Sliding Log?**
- These are the highest-risk endpoints in any system. A brute-force attacker tries thousands of password combinations.
- Fixed Window's boundary burst means an attacker can attempt 10 logins in the span of two adjacent window boundaries.
- Sliding Log guarantees that no more than N attempts are possible in any rolling window — the constraint is mathematically airtight.
- Memory cost is low because the policy limit is small (e.g., 5 attempts/minute).

**Recommended policy:** `{ algorithm: 'sliding_log', limitCount: 5, windowSeconds: 60, failureMode: 'closed', identityType: 'ip' }`

The `failureMode: 'closed'` is critical here — the login endpoint should never fail-open during a Redis outage (see `Database.md Section 4, Q3`).

---

### General API Reads — Token Bucket

```
GET /api/data
GET /api/users
GET /api/reports
```

**Why Token Bucket?**
- Developers query these endpoints interactively. A developer running a debug loop or testing their code will fire several requests quickly — this is legitimate behaviour, not abuse.
- Token Bucket allows controlled bursts without penalising legitimate usage patterns.
- The refill rate enforces a sustainable long-term limit even if short bursts are allowed.
- Memory footprint is small and constant regardless of traffic volume.

**Recommended policy:** `{ algorithm: 'token_bucket', limitCount: 1000, windowSeconds: 60, identityType: 'user' }`

This allows up to 1,000-token bursts (for a user who has been idle) and refills at ~16.7 tokens/second.

---

### Job Submission / Expensive Write Operations — Leaky Bucket

```
POST /api/jobs/submit
POST /api/reports/generate
POST /api/export
```

**Why Leaky Bucket?**
- These endpoints trigger expensive downstream work (database-heavy jobs, report generation, third-party API calls).
- The downstream system can only handle a fixed processing rate.
- Leaky Bucket enforces a smooth input rate, protecting the downstream pipeline regardless of how bursty the client is.
- Unlike Token Bucket, Leaky Bucket does not allow accumulated idle time to produce a burst — the processing rate is always the bottleneck.

**Recommended policy:** `{ algorithm: 'leaky_bucket', limitCount: 10, windowSeconds: 60, leakRatePerSecond: 0.5, identityType: 'user' }`

10 jobs can queue up, draining at 0.5/second (one job every 2 seconds).

---

### Per-User API Quotas — Sliding Window

```
GET /api/data      (when per-user daily/hourly limits matter)
POST /api/webhooks
```

**Why Sliding Window?**
- When you need to enforce a reasonable "no boundary burst" policy without the memory cost of Sliding Log.
- Users expect their quota to be tracked fairly across time, not gamed at window boundaries.
- The approximation error is negligible for coarse quota enforcement (e.g., 1,000 requests per hour).

**Recommended policy:** `{ algorithm: 'sliding_window', limitCount: 1000, windowSeconds: 3600, identityType: 'user' }`

---

### System-Wide Catch-All / IP Throttling — Fixed Window

```
Any endpoint (identity_type: 'global' or 'ip' wildcard)
```

**Why Fixed Window?**
- Global catch-all policies need to be evaluated extremely cheaply. At high traffic volumes, even a slight increase in per-request computation adds up.
- Fixed Window's simplicity (single INCR + TTL) makes it the fastest algorithm.
- The boundary burst problem is less of a concern at coarse global limits (e.g., 10,000 req/min per IP) — the burst is small relative to the limit.
- It serves as a "floor" — preventing the most egregious abuse before more precise per-user policies run.

**Recommended policy:** `{ algorithm: 'fixed_window', limitCount: 10000, windowSeconds: 60, identityType: 'ip', ipAddress: '0.0.0.0/0', priority: 0 }`

(Low priority — more specific policies take precedence.)

---

### Algorithm Selection Quick Reference

| Endpoint Type | Algorithm | Key Reason |
|---|---|---|
| Login, register, password reset | **Sliding Log** | Exact rolling window — no boundary burst possible |
| Sensitive mutations (delete account, change email) | **Sliding Log** | Same — security-critical, low volume |
| General API reads | **Token Bucket** | Burst-tolerant, developer-friendly |
| Expensive background jobs | **Leaky Bucket** | Smooth processing rate, protects downstream |
| Per-user hourly/daily quota | **Sliding Window** | Fair, anti-burst, memory-efficient |
| Global IP rate limit (catch-all) | **Fixed Window** | Fastest, lowest overhead |

---

## 10. Lua Script Cross-Reference

All Lua scripts execute atomically on Redis. The complete pseudocode is split across two documents:

| Algorithm | Pseudocode Location |
|---|---|
| **Fixed Window** | `Redis.md Section 5 — Fixed Window` |
| **Sliding Window** | `Algorithms.md Section 4 — Lua Script Logic` (this document) |
| **Sliding Log** | `Algorithms.md Section 5 — Lua Script Logic` (this document) |
| **Token Bucket** | `Redis.md Section 5 — Token Bucket` |
| **Leaky Bucket** | `Algorithms.md Section 7 — Lua Script Logic` (this document) |

**Why split across two documents?** Redis.md covers Fixed Window and Token Bucket as the primary teaching examples for Redis atomicity (they introduce the race condition concept). Algorithms.md covers the remaining three in the context of their algorithmic design — the Lua logic is presented alongside the analogy and the worked example, so you can read both together.

---

*Related documents:*
- [`docs/Redis.md`](./Redis.md) — Redis key design, TTL strategy, and Fixed Window / Token Bucket Lua pseudocode
- [`docs/Database.md`](./Database.md) — The `policies` table schema, including `algorithm`, `limit_count`, `window_seconds`, and `leak_rate_per_second`
- [`docs/API.md`](./API.md) — How to create policies via the REST API, including algorithm selection and validation rules
