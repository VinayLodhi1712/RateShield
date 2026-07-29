# RateShield

**Version:** 1.0
**Date:** 2026-07-29
**Author:** Vinay Anand Lodhi

### Version History

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-07-29 | Initial PRD |

----------------------------------------

## Product Overview

RateShield is a production-ready distributed rate limiting platform built to protect APIs from abuse while maintaining high availability and scalability.

The system supports multiple rate limiting algorithms, distributed coordination using Redis, configurable policies, monitoring, analytics, and an administration dashboard.

The primary objective of this project is to learn advanced backend engineering concepts including distributed systems, caching, concurrency, Docker, monitoring, and scalable API design.

----------------------------------------

## Problem Statement

Modern APIs receive millions of requests every day.

Without rate limiting:

- APIs become overloaded.
- Attackers can abuse endpoints.
- Expensive operations can exhaust resources.
- Fair usage cannot be enforced.

Current Node.js tutorials mostly demonstrate simple in-memory limiters which fail in distributed environments.

This project aims to build a production-like distributed solution.

----------------------------------------

## Goals

- Build a distributed rate limiter.
- Learn Redis.
- Learn caching.
- Learn atomic operations.
- Learn scalable backend architecture.
- Learn Docker.
- Learn monitoring.
- Learn load testing.
- Learn API security.
- Learn system design.
- Create an interview-ready backend project.

----------------------------------------

## Non Goals

- Machine Learning
- AI
- Billing
- Payment Gateway
- User Interface complexity
- Microservices
- Kubernetes

----------------------------------------

## Target Users

- Developers
- Backend Engineers
- Companies exposing APIs
- Students learning backend engineering

----------------------------------------

## Functional Requirements

**Authentication**
- JWT Login
- User Roles
- API Keys

**Rate Limiting**
- Fixed Window
- Sliding Window
- Sliding Log
- Token Bucket
- Leaky Bucket

**Redis Storage**
- Distributed Counters
- Atomic Updates
- TTL Support

**Policies**
- Endpoint Policies
- User Policies
- IP Policies

**Admin APIs**
- Monitoring
- Analytics
- Health Checks
- Logs

**Documentation**
- Swagger Documentation
- Docker Support

----------------------------------------

## Non Functional Requirements

- Low latency
- Horizontal scalability
- Fault tolerance
- Thread safety
- Clean architecture
- Testability
- Maintainability
- Production-ready folder structure

----------------------------------------

## Success Metrics

Each metric below is stated with a concrete measurement method so it can actually be verified, not just claimed.

- **Throughput:** Sustain 1,000+ concurrent requests with p99 latency under 50ms, measured via k6 load test reports (see `load-testing/`).
- **Algorithm coverage:** All 5 rate limiting algorithms (Fixed Window, Sliding Window, Sliding Log, Token Bucket, Leaky Bucket) implemented, unit-tested, and independently selectable per policy.
- **Deployment:** Full stack (API, Redis, Postgres, Prometheus, Grafana) runs via a single `docker compose up`.
- **Observability:** Live Prometheus metrics (request rate, rejection rate, latency histograms) visualized in a Grafana dashboard.
- **Test coverage:** 90%+ statement coverage on `backend/src`, measured via Jest coverage reports.
- **Documentation:** All 8 docs in `docs/` (PRD, Architecture, API, Database, Redis, Algorithms, Deployment, Testing) complete and kept in sync with the implementation at each milestone.

----------------------------------------

## Tech Stack

- Node.js
- Express
- Redis
- PostgreSQL
- JWT
- Docker
- Prometheus
- Grafana
- K6
- Swagger
- Winston
- Jest

----------------------------------------

## Deliverables

- Working Backend
- Dashboard
- Docker Compose
- API Documentation
- Architecture Diagram
- README
- Performance Report
- Deployment Guide
- Lessons Learned

----------------------------------------

## Stretch Goal

Package the core rate-limiting middleware (the Redis-backed algorithm layer, independent of the rest of the app) as a standalone, publishable npm module — e.g. `npm install rateshield` — usable as drop-in Express middleware in other projects.

This is optional and should only be attempted after the core milestones (through distributed locking) are complete and stable. It is what would move this project from "a well-documented learning repo" to "a small open-source tool with real potential users" — a stronger interview story than the app alone.