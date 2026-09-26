# Phase 5 — Booking Engine Architecture & Implementation Plan

**Project:** Young Tours & Travels  
**Phase:** 5 — Booking Engine, Inventory Holds, Passenger Manifests & State Machine  
**Document:** Master Architecture & Engineering Plan  
**Status:** **STEP 0 — PLANNING (DOCUMENTATION-ONLY • NO CODE)** [DECISION]  
**Baseline Commit:** `371dde4` (`docs(phase-4): finalize search and availability freeze`)

---

## 1. Executive Summary & Objective

Phase 5 introduces the core **Booking Engine** for Young Tours & Travels. Building on the frozen Phase 4 search and derived inventory availability foundation, Phase 5 establishes:

1. **Transactional 15-Minute Seat Holds** (`inventory_holds` ledger) ensuring zero double-booking during checkout.
2. **Immutable Booking Snapshots** preserving package details, day-by-day itineraries, and exact pricing calculations historically.
3. **Passenger Roster Management** supporting adult and child travelers with structured validation and admin manifest generation.
4. **Deterministic Booking State Machine** managing the complete lifecycle from hold reservation to booking confirmation and self-service cancellation.
5. **Customer & Admin REST APIs** providing booking creation, history, cancellation, and departure passenger rosters.
6. **Asynchronous Hold Sweeper Architecture** powered by BullMQ/Redis for proactive hold release, paired with PostgreSQL authoritative query-level expiry guards.

Phase 5 strictly encapsulates the booking and reservation domain without implementing payment gateway transactions, Razorpay/Stripe webhooks, tax invoices, or e-ticket PDFs (which are formally deferred to Phase 6).

---

## 2. Hard Scope & Phase Boundaries

```
+-----------------------------------------------------------------------------+
|                      PHASE 5: BOOKING ENGINE (CURRENT)                      |
|  - Booking creation & unique reference (BK-YYYYMMDD-XXXX)                  |
|  - 15-minute temporary seat hold reservation & release                      |
|  - Pessimistic locking (SELECT ... FOR UPDATE) on departures                |
|  - Immutable JSONB historical snapshots (Package, Departure, Itinerary, Price)
|  - Passenger validation & structured roster storage (age-at-booking)        |
|  - Booking state transitions (AWAITING_PAYMENT, CONFIRMED, CANCELLED, EXPIRED)
|  - Customer booking APIs (Create, List, Details, Cancel)                    |
|  - Admin departure passenger manifest generation & booking audit APIs       |
|  - Hold expiry background sweeper (BullMQ/Redis)                            |
+-----------------------------------------------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------+
|                PHASE 6: PAYMENTS & FULFILLMENT (DEFERRED)                   |
|  - Razorpay / Stripe gateway driver integration                             |
|  - Checkout order creation & payment webhook verification                   |
|  - Late payment reconciliation & automated refund execution                 |
|  - GST-compliant Tax Invoice generation (INV-YYYYMM-XXXX PDF)               |
|  - E-Ticket / Travel Voucher generation (VCH-YYYYMMDD-XXXX PDF)             |
+-----------------------------------------------------------------------------+
```

---

## 3. Inventory & Hold Semantics (Resolution of Q1–Q8)

### Q1: When is an inventory hold created?

- **Answer:** An inventory hold is created when a customer initiates checkout (`POST /api/v1/bookings`).
- Inside an ACID PostgreSQL transaction, the departure schedule is locked via `SELECT ... FOR UPDATE`, remaining derived availability is evaluated, and an `ACTIVE` hold row is inserted into `inventory_holds` with `expires_at = NOW() + INTERVAL '15 minutes'`.

### Q2: When does `departure_schedules.booked_seats` increase?

- **Answer:** `booked_seats` increases **ONLY** when a booking transitions to `CONFIRMED` upon verified successful payment (via Phase 6 payment confirmation).
- During checkout in Phase 5, `booked_seats` is NOT incremented; seats are protected strictly via the active `inventory_holds` entry. When confirmed, `booked_seats` is atomically incremented, and the hold status is transitioned to `COMMITTED`. Unbacked admin overrides to `CONFIRMED` without payment are strictly prohibited.

### Q3: When are held seats released?

- **Answer:** Held seats are released under three conditions:
  1. **User Cancellation:** The customer explicitly cancels or abandons checkout before expiration (`status = 'RELEASED'`).
  2. **Expiration:** 15 minutes elapse without payment confirmation (`expires_at <= NOW()`), after which PostgreSQL availability queries automatically treat the hold as inactive, and the background worker updates status to `'EXPIRED'`.
  3. **Booking Cancellation:** A pending unconfirmed booking is cancelled by customer or admin.

### Q4: What happens when the 15-minute hold expires?

- **Answer:** The hold becomes ineffective immediately at the database level because all availability and checkout queries enforce `AND expires_at > NOW()`. The seats instantly become available for other customers to reserve. The BullMQ background worker asynchronously marks the database row as `'EXPIRED'`.

### Q5: What happens when payment succeeds later in Phase 6?

- **Answer:** Strict policy on payment verification vs hold status:
  - **`ACTIVE` Hold + Valid Payment:** The webhook locks the departure via `SELECT ... FOR UPDATE`, marks the hold as `COMMITTED`, atomically increments `booked_seats = booked_seats + party_size`, and transitions the booking status to `CONFIRMED`.
  - **`EXPIRED` Hold + Late Payment:** **DO NOT automatically confirm.** Expired holds are never resurrected into confirmed bookings (avoiding race conditions against other users who may have booked the freed seats). Phase 6 payment reconciliation marks the payment as unallocated and triggers an automated refund / support notification.

### Q6: How do we prevent overbooking?

- **Answer:** Overbooking is prevented via a dual-layer invariant:
  1. **PostgreSQL Constraint:** `CONSTRAINT chk_departure_capacity_bounds CHECK (booked_seats <= total_seat_capacity)`.
  2. **Authoritative Formula & Pessimistic Locking:**
     $$\text{availableSeats} = \max\left(0, \text{totalSeatCapacity} - \text{bookedSeats} - \text{activeUnexpiredHeldSeats}\right)$$
     Executed under `SELECT ... FOR UPDATE` on the departure schedule row during hold creation and confirmation.

### Q7: How do concurrent users compete for the final available seats?

- **Answer:** PostgreSQL transaction serialization with row-level pessimistic locking (`SELECT ... FOR UPDATE`) ensures that concurrent checkout requests for the same departure execute strictly in serialized sequence. The first transaction to acquire the lock reserves the hold; subsequent concurrent transactions wait on the lock and immediately evaluate updated remaining seats upon release. If remaining seats $< \text{partySize}$, the transaction aborts with a clean `INSUFFICIENT_INVENTORY` error.

### Q8: What happens if the HTTP response is lost after the DB transaction succeeds?

- **Answer:** The client resends the request with the same `Idempotency-Key` header. The backend checks `(user_id, endpoint_scope, idempotency_key)`, validates that `request_hash` matches, and returns the identical cached response (including booking reference and hold details) without re-executing seat reservation or creating duplicate holds.

---

## 4. Transaction Boundaries & Cancellation Atomicity

```
[Incoming Request: POST /api/v1/bookings with Idempotency-Key]
   │
   ├─► Check Idempotency Record: (user_id, endpoint_scope, idempotency_key)
   │     └─ If matched & hash valid: Return cached response immediately
   │     └─ If matched & hash mismatch: Return 409 IDEMPOTENCY_CONFLICT
   │
   ├─► BEGIN PostgreSQL Transaction
   │     │
   │     ├─ 1. Lock Departure Row:
   │     │     SELECT * FROM departure_schedules WHERE id = $1 FOR UPDATE;
   │     │
   │     ├─ 2. Calculate Derived Real-Time Availability:
   │     │     available = total_capacity - booked_seats - SUM(active unexpired holds)
   │     │     IF available < party_size -> ROLLBACK & THROW InsufficientInventoryError
   │     │
   │     ├─ 3. Insert 15-Minute Hold:
   │     │     INSERT INTO inventory_holds (departure_id, checkout_session_token, held_seats, expires_at)
   │     │     VALUES ($1, $token, $seats, NOW() + INTERVAL '15 min') RETURNING id;
   │     │
   │     ├─ 4. Generate Unique Booking Reference:
   │     │     BK-YYYYMMDD-XXXX (Cryptographically random alphanumeric)
   │     │
   │     ├─ 5. Insert Immutable Booking Record:
   │     │     INSERT INTO bookings (..., package_snapshot, departure_snapshot, itinerary_snapshot, price_breakdown, status='AWAITING_PAYMENT')
   │     │
   │     ├─ 6. Insert Passenger Roster:
   │     │     INSERT INTO booking_passengers (booking_id, full_name, age_at_booking, date_of_birth, gender, passenger_type, special_requests)
   │     │
   │     └─ 7. Record Idempotency Key & Response Payload
   │
   ├─► COMMIT PostgreSQL Transaction
   │
   ├─► Schedule Delayed BullMQ Hold Sweeper Job (15m delay)
   │
   └─► Return HTTP 201 Created (Booking Reference, Hold Expiration, Pricing Summary)
```

### Cancellation Atomicity & Double-Decrement Guard

For `CONFIRMED` $\rightarrow$ `CANCELLED` transitions:

- Cancellation uses conditional SQL update:
  ```sql
  UPDATE bookings
  SET status = 'CANCELLED', cancelled_at = NOW(), cancellation_reason = $1
  WHERE id = $2 AND status = 'CONFIRMED'
  RETURNING *;
  ```
- `booked_seats = booked_seats - $party_size` executes **only if** the update returned a row.
- If already cancelled, 0 rows update $\to$ no inventory decrement $\to$ returns `BOOKING_ALREADY_CANCELLED` (409) or cached idempotent response, preventing double-decrement.

---

## 5. Security & Threat Modeling

1. **Object-Level Authorization & IDOR Prevention:**
   - Customers can strictly view and cancel bookings where `booking.customer_id === request.user.id`.
   - Access attempts to other customers' bookings return `404 Not Found` (or `403 Forbidden`) with zero information leakage.
2. **Hold Session Guard:**
   - Holds are bound to authenticated `user_id` and unique `checkout_session_token`. A hold cannot be manipulated by an unauthorized session.
3. **Replay & Concurrency Protection:**
   - Enforce mandatory `Idempotency-Key` validation on all state-mutating endpoints (`POST /bookings`, `POST /bookings/:ref/cancel`) scoped by `(user_id, endpoint_scope, idempotency_key)`.
4. **Passenger Privacy & Data Protection:**
   - Passenger details are strictly validated against strict Zod schemas (preventing SQL injection or arbitrary JSON payload injection).
   - Only non-sensitive operational preferences (`special_requests`) are collected; sensitive medical data is excluded.
   - Only admins and authenticated booking owners can view passenger manifests.

---

## 6. Error Catalogue

All errors use the canonical Phase 1 envelope:

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "Only 2 seats remaining for this departure, which is less than requested party size of 4.",
    "details": [
      {
        "field": "partySize",
        "issue": "Requested seats exceed available capacity"
      }
    ]
  },
  "meta": {
    "timestamp": "2026-09-26T05:45:00.000Z",
    "requestId": "req_uuid_123"
  }
}
```

Canonical Phase 5 Error Codes:

- `BOOKING_NOT_FOUND` (404)
- `DEPARTURE_NOT_FOUND` (404)
- `DEPARTURE_NOT_OPEN` (400)
- `INSUFFICIENT_INVENTORY` (409)
- `HOLD_EXPIRED` (410)
- `HOLD_NOT_FOUND` (404)
- `BOOKING_ALREADY_CANCELLED` (409)
- `BOOKING_CANNOT_BE_CANCELLED` (400)
- `IDEMPOTENCY_CONFLICT` (409)
- `INVALID_PASSENGER_DATA` (400)
- `UNAUTHORIZED_BOOKING_ACCESS` (403)
