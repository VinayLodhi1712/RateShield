# RateShield Load Testing Suite (k6)

This directory contains automated performance and load testing scenarios using [k6](https://k6.io/).

---

## 1. Prerequisites

Install `k6` on your system:

- **Windows (winget):** `winget install k6` or `choco install k6`
- **macOS (Homebrew):** `brew install k6`
- **Linux (apt):** `sudo apt-get install k6`
- **Docker:** `docker run --rm -i grafana/k6 run - <load-tests/smoke.js`

---

## 2. Test Scenarios

### Smoke Test (Baseline Sanity)
Verifies basic health checks, response formats, and Prometheus metric exporters with 3 concurrent Virtual Users (VUs):
```bash
k6 run load-tests/smoke.js
```

### Burst Test (Rate Limit Atomicity)
Dispatches 50 requests/sec bursts to validate atomic Lua rate limit decrementing, header accuracy, and HTTP 429 throttling:
```bash
k6 run load-tests/burst.js
```

### Stress Test (High Concurrency & Saturation)
Ramps up to 60 concurrent VUs over 60 seconds to measure system throughput, P95/P99 latency percentiles, and memory resilience:
```bash
k6 run load-tests/stress.js
```

---

## 3. Custom Target URL

To target a remote staging or production deployment:
```bash
k6 run -e TARGET_URL=https://api.yourdomain.com load-tests/smoke.js
```
