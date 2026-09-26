# Phase 5 — Implementation Roadmap & Execution Sequence

**Project:** Young Tours & Travels  
**Phase:** 5 — Booking Engine, Inventory Holds, Passenger Manifests & State Machine  
**Document:** Implementation Roadmap & Step-by-Step Specification  
**Status:** **STEP 0 — PLANNING (DOCUMENTATION-ONLY • NO CODE)** [DECISION]  
**Baseline Commit:** `371dde4` (`docs(phase-4): finalize search and availability freeze`)

---

## 1. Overview & Master Step Sequence

This roadmap outlines the exact execution sequence for Phase 5. Following the proven architectural progression from Phases 1–4, Phase 5 progresses strictly through decoupled, fully-audited milestones:

```
Step 0: Requirements, Architecture & Engineering Plan (Current)
  │
  ├─► Step 1: Database Migrations & Schema (Bookings, Passengers, Idempotency)
  │
  ├─► Step 2: Shared Zod Schemas & Contract Definitions (@travel-web/shared)
  │
  ├─► Step 3: PostgreSQL Data Access Layer / Repositories
  │
  ├─► Step 4: Booking Domain Services & State Machine Logic
  │
  ├─► Step 5: Inventory Hold Integration & Pessimistic Concurrency Engine
  │
  ├─► Step 6: Customer HTTP APIs (Create, List, Details, Cancel)
  │
  ├─► Step 7: Admin HTTP APIs (Booking Management & Departure Manifests)
  │
  ├─► Step 8: Frontend Booking UI & Checkout Flow (Vanilla HTML/CSS/JS)
  │
  ├─► Step 9: Background Hold Expiry Worker & BullMQ Sweeper
  │
  ├─► Step 10: End-to-End, Concurrency Contention & Security Attack Tests
  │
  └─► Step 11: Final Phase 5 Security Audit, Verification & Code Freeze
```

---

## 2. Step-by-Step Execution Plan

### Step 0: Requirements, Architecture & Engineering Plan (Documentation-Only)

- **Objective:** Establish the production-grade architecture, state machine, data model, concurrency strategy, and implementation plan for Phase 5.
- **Scope:** Documentation creation under `docs/phase-5/`. Zero code, schema, or configuration modifications.
- **Deliverables:**
  - `docs/phase-5/PHASE-5-BOOKING-PLAN.md`
  - `docs/phase-5/PHASE-5-STATE-MACHINE.md`
  - `docs/phase-5/PHASE-5-DATA-MODEL.md`
  - `docs/phase-5/PHASE-5-REQUIREMENTS-TRACEABILITY.md`
  - `docs/phase-5/PHASE-5-IMPLEMENTATION-ROADMAP.md`
- **Dependencies:** Frozen Phase 4 baseline (`371dde4`).
- **Tests / Checks:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`.
- **Acceptance Criteria:** 100% green existing test suite; zero source code changes; clean architectural review.
- **Explicit Out of Scope:** Writing SQL migrations, shared schemas, backend logic, or UI.

---

### Step 1: Database Migrations & Schema

- **Objective:** Create PostgreSQL tables, foreign key constraints, indexes, and check constraints for bookings, passengers, and idempotency tracking.
- **Scope:**
  - Migration `008_create_bookings_and_passengers.sql`.
  - Tables: `bookings`, `booking_passengers`, `idempotency_keys`.
  - Check constraints: `chk_booking_total_price_positive`, `chk_party_size_positive` (`party_size >= 1`), `chk_adult_count_positive` (`adult_count >= 0`), `chk_child_count_positive` (`child_count >= 0`), `chk_party_size_sum`, `chk_passenger_age_range` (`age_at_booking BETWEEN 0 AND 120`), `chk_passenger_type`.
  - Unique indexes: `uq_bookings_reference`, `uq_bookings_hold_id`, `uq_idempotency_user_endpoint_key` `(user_id, endpoint_scope, idempotency_key)`.
- **Expected Files:**
  - `backend/src/db/migrations/008_create_bookings_and_passengers.sql`
- **Dependencies:** Step 0 approved; existing migrations 001–007.
- **Tests:** Migration up/down execution tests; constraint validation tests in scratch test scripts.
- **Acceptance Criteria:** Migrations run cleanly up and down against PostgreSQL; all foreign keys, check constraints, and indexes pass verification.
- **Explicit Out of Scope:** Application repositories or services.

---

### Step 2: Shared Zod Schemas & TypeScript Contracts

- **Objective:** Define end-to-end type-safe Zod validation schemas and TypeScript types in `@travel-web/shared` for all booking request/response payloads, snapshots (package, departure, itinerary, price breakdown), passenger rosters, and error envelopes.
- **Scope:**
  - Schemas: `CreateBookingRequestSchema`, `BookingResponseSchema`, `BookingListResponseSchema`, `PassengerSchema`, `PriceBreakdownSchema`, `PackageSnapshotSchema`, `DepartureSnapshotSchema`, `ItinerarySnapshotSchema`, `DepartureManifestResponseSchema`.
  - Enums: `BookingStatusEnum` (`AWAITING_PAYMENT`, `CONFIRMED`, `CANCELLED`, `EXPIRED`), `PassengerTypeEnum` (`ADULT`, `CHILD`), `PassengerGenderEnum`.
- **Expected Files:**
  - `shared/src/schemas/booking.schema.ts`
  - `shared/src/types/booking.types.ts`
  - `shared/src/index.ts` (export updates)
- **Dependencies:** Step 1 schema definitions.
- **Tests:** Shared schema unit tests (`shared/src/__tests__/booking.schema.test.ts`).
- **Acceptance Criteria:** `npm run build:shared` compiles without error; 100% test coverage for passenger validation and boundary schemas.
- **Explicit Out of Scope:** Backend route handlers or database queries.

---

### Step 3: PostgreSQL Data Access Layer / Repositories

- **Objective:** Implement parameterized, SQL-injection safe, transaction-aware repositories for bookings, passengers, and idempotency records.
- **Scope:**
  - `BookingRepository`: `createBooking()`, `findById()`, `findByReference()`, `findByCustomerId()`, `updateStatus()`, `cancelBooking()`, `getManifestByDepartureId()`.
  - `PassengerRepository`: `createPassengers()`, `findByBookingId()`.
  - `IdempotencyRepository`: `get()`, `set()`, `delete()`.
- **Expected Files:**
  - `backend/src/modules/booking/repositories/booking.repository.ts`
  - `backend/src/modules/booking/repositories/passenger.repository.ts`
  - `backend/src/modules/booking/repositories/idempotency.repository.ts`
  - `backend/src/modules/booking/index.ts`
- **Dependencies:** Step 1 migrations and Step 2 shared types.
- **Tests:** Repository integration tests verifying SQL queries, parameterization, and transaction rollback behavior.
- **Acceptance Criteria:** Repositories support optional `PoolClient` transaction passing; zero raw unparameterized SQL.
- **Explicit Out of Scope:** Domain business rules and Fastify controllers.

---

### Step 4: Booking Domain Services & State Machine Logic

- **Objective:** Implement core domain business services managing the booking lifecycle, state machine transitions, immutable snapshot generation, and price calculation.
- **Scope:**
  - `BookingService`: Reference generation (`BK-YYYYMMDD-XXXX`), immutable snapshotting of packages, departures, and itineraries, pricing calculation and breakdown generation, state transitions.
  - `CancellationService`: Cancellation eligibility checks, refund estimation notes, state mutation with single-decrement atomic guards.
- **Expected Files:**
  - `backend/src/modules/booking/services/booking.service.ts`
  - `backend/src/modules/booking/services/cancellation.service.ts`
  - `backend/src/modules/booking/services/snapshot.service.ts`
- **Dependencies:** Step 3 repositories and Phase 4 package/departure services.
- **Tests:** Unit tests for reference generation uniqueness, snapshot immutability, price breakdown calculation, and state transition guards.
- **Acceptance Criteria:** All business rules from Phase 0 and Phase 5 specs pass unit tests; invalid transitions throw canonical domain errors.
- **Explicit Out of Scope:** HTTP routes and payment gateway drivers.

---

### Step 5: Inventory Hold Integration & Pessimistic Concurrency Engine

- **Objective:** Wire together the Phase 4 `inventory_holds` ledger with Phase 5 booking creation inside serializable/pessimistic PostgreSQL transactions (`SELECT ... FOR UPDATE`).
- **Scope:**
  - Transaction orchestration: Departure row locking -> Availability evaluation -> Hold creation -> Booking insertion -> Passenger insertion -> Idempotency record -> Transaction commit.
  - Guaranteed enforcement of the zero-double-booking invariant under concurrent checkout attempts.
- **Expected Files:**
  - `backend/src/modules/booking/services/booking-transaction.service.ts`
  - `backend/src/modules/inventory/repositories/inventory-hold.repository.ts` (extended if needed)
- **Dependencies:** Step 4 booking services, Step 3 repositories, Phase 4 inventory modules.
- **Tests:** Unit and integration tests simulating concurrent transactions competing for final remaining seats.
- **Acceptance Criteria:** Zero overbooking possible; atomic transaction rollback on inventory exhaustion.
- **Explicit Out of Scope:** Fastify route registration.

---

### Step 6: Customer HTTP APIs

- **Objective:** Expose customer-facing booking endpoints with authentication, rate limiting, and strict request/response validation.
- **Scope:**
  - `POST /api/v1/bookings` (Create booking & 15m hold)
  - `GET /api/v1/bookings` (List customer booking history with pagination)
  - `GET /api/v1/bookings/:reference` (Customer booking details & snapshot)
  - `POST /api/v1/bookings/:reference/cancel` (Customer self-service cancellation)
- **Expected Files:**
  - `backend/src/modules/booking/routes/booking.routes.ts`
  - `backend/src/modules/booking/controllers/booking.controller.ts`
  - `backend/src/app.ts` (route registration)
- **Dependencies:** Step 5 transaction services, auth middlewares, validation schemas.
- **Tests:** Supertest API integration tests; IDOR authorization tests; bad input validation tests.
- **Acceptance Criteria:** Canonical envelope format across all endpoints; customer A cannot view or cancel Customer B's booking.
- **Explicit Out of Scope:** Admin routes and Phase 6 payments.

---

### Step 7: Admin HTTP APIs

- **Objective:** Expose administrative endpoints for booking oversight and departure passenger manifest generation.
- **Scope:**
  - `GET /api/v1/admin/bookings` (Admin search/filter bookings)
  - `GET /api/v1/admin/bookings/:reference` (Admin booking inspection)
  - `GET /api/v1/admin/departures/:id/manifest` (Admin passenger manifest with total confirmed passengers and special requests)
- **Expected Files:**
  - `backend/src/modules/booking/routes/admin-booking.routes.ts`
  - `backend/src/modules/booking/controllers/admin-booking.controller.ts`
- **Dependencies:** Step 6 customer APIs and admin RBAC middleware (`requireRole('ADMIN')`).
- **Tests:** Admin RBAC boundary tests; non-admin forbidden tests; manifest format verification.
- **Acceptance Criteria:** Manifest aggregates confirmed and active-hold passengers; strict 403 Forbidden for non-admin tokens.
- **Explicit Out of Scope:** Modifying customer payment transactions.

---

### Step 8: Frontend Booking UI & Checkout Flow

- **Objective:** Build the customer-facing booking and checkout experience in the existing Vanilla HTML/CSS/JS frontend.
- **Scope:**
  - Interactive passenger roster input form (Adults, Children, Special Requests).
  - 15-minute countdown hold timer with auto-expiration warning.
  - Price summary breakdown card with live calculation.
  - Booking confirmation success page with reference display.
  - Customer booking history & cancellation modal in user dashboard.
- **Expected Files:**
  - `frontend/src/pages/checkout.html`
  - `frontend/src/js/checkout.js`
  - `frontend/src/js/bookings.js`
  - `frontend/src/css/checkout.css`
  - `frontend/src/js/api.js` (booking API methods)
- **Dependencies:** Step 6 customer APIs.
- **Tests:** Browser subagent UI validation; client-side validation tests; hold countdown integration.
- **Acceptance Criteria:** Seamless, responsive, glassmorphic checkout UI; real-time validation; clean error handling.
- **Explicit Out of Scope:** Phase 6 payment card forms / Razorpay checkout popup.

---

### Step 9: Background Hold Expiry Worker & BullMQ Sweeper

- **Objective:** Implement the asynchronous BullMQ/Redis worker to transition expired holds and abandoned bookings.
- **Scope:**
  - Worker job definition: `hold-expiry-processor.ts`.
  - Queue registration and scheduling: Delayed jobs on hold creation + periodic 60-second sweeper cron.
  - Database status transition: `'ACTIVE'` -> `'EXPIRED'`.
- **Expected Files:**
  - `worker/src/processors/hold-expiry.processor.ts`
  - `worker/src/queues/inventory.queue.ts`
  - `worker/src/index.ts`
- **Dependencies:** Step 5 inventory hold service, BullMQ, Redis.
- **Tests:** Worker unit tests with mock Redis; automated job execution tests.
- **Acceptance Criteria:** Expired holds reliably marked as `'EXPIRED'` in DB; zero stale active holds remaining indefinitely.
- **Explicit Out of Scope:** Phase 6 payment refund workers.

---

### Step 10: End-to-End, Concurrency Contention & Security Attack Tests

- **Objective:** Perform comprehensive multi-threaded concurrency testing and security vulnerability scans.
- **Scope:**
  - Concurrency test: 50 concurrent requests competing for the last 2 seats on a departure (0 overbooking verification).
  - Idempotency test: Rapid burst of identical requests with the same `Idempotency-Key` resulting in exactly 1 hold.
  - Security test: IDOR attack matrix across customer booking endpoints.
  - Snapshot test: Mutating package title/price in DB does not alter historical booking snapshot.
- **Expected Files:**
  - `tests/integration/booking.concurrency.test.ts`
  - `tests/integration/booking.idor-security.test.ts`
  - `tests/integration/booking.snapshot-immutability.test.ts`
- **Dependencies:** Steps 1–9 complete.
- **Tests:** Full Jest/Supertest suite.
- **Acceptance Criteria:** All concurrency, security, and snapshot tests pass with 100% assertion success; 0 flakiness.
- **Explicit Out of Scope:** Modifying implementation logic unless fixing test failures.

---

### Step 11: Final Phase 5 Security Audit, Verification & Code Freeze

- **Objective:** Conduct exhaustive code freeze audit, update master documentation, verify test regressions, and freeze Phase 5.
- **Scope:**
  - Complete repository linting, typecheck, formatting, and test suite execution.
  - Produce `docs/phase-5/PHASE-5-FREEZE-REPORT.md`.
  - Git tag / baseline freeze.
- **Expected Files:**
  - `docs/phase-5/PHASE-5-FREEZE-REPORT.md`
- **Dependencies:** Step 10 passed.
- **Tests:** Entire project test suite (`npm test`, `npm run build`).
- **Acceptance Criteria:** 100% test pass rate across all phases (Phase 0–5); zero lint/typecheck errors; clean freeze document.
- **Explicit Out of Scope:** Any new feature additions.

---

## 3. Future Acceptance & Exit Criteria Summary

| Area                       | Future Step | Primary Acceptance Criteria                                                                         |
| :------------------------- | :---------- | :-------------------------------------------------------------------------------------------------- |
| **Database Schema**        | Step 1      | `bookings`, `booking_passengers`, `idempotency_keys` tables with strict constraints & foreign keys. |
| **Contracts**              | Step 2      | Type-safe Zod schemas in `@travel-web/shared` covering all payloads & snapshots.                    |
| **Data Access**            | Step 3      | Transaction-capable, parameterized repositories with 0 raw dynamic SQL.                             |
| **Domain Services**        | Step 4      | Deterministic state machine, `BK-YYYYMMDD-XXXX` reference generation, immutable JSONB snapshots.    |
| **Hold Concurrency**       | Step 5      | Pessimistic locking (`SELECT ... FOR UPDATE`) guaranteeing 0 overbooking during 15m holds.          |
| **Customer API**           | Step 6      | Fastify REST endpoints for create, list, view, and cancel booking adhering to canonical envelope.   |
| **Admin API**              | Step 7      | Admin search and departure passenger manifest generation with strict RBAC.                          |
| **Frontend UI**            | Step 8      | Responsive HTML5/CSS3 checkout flow with live hold countdown timer and passenger inputs.            |
| **Background Worker**      | Step 9      | BullMQ/Redis worker proactively transitioning expired holds to `'EXPIRED'`.                         |
| **Concurrency & Security** | Step 10     | High-contention concurrency tests pass; IDOR security tests pass; snapshot immutability verified.   |
| **Audit & Freeze**         | Step 11     | Complete project test suite 100% green; zero regression in Phase 1–4; frozen baseline tag.          |
