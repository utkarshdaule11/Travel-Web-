# Phase 5 — Requirements Traceability Matrix

**Project:** Young Tours & Travels  
**Phase:** 5 — Booking Engine  
**Document:** End-to-End Traceability Matrix  
**Status:** **STEP 0 — PLANNING (DOCUMENTATION-ONLY • NO CODE)** [DOCUMENTED]

---

## 1. Requirements Traceability Matrix

| Req ID            | Requirement Description                   | Business Rule & Invariant                                                                               | Database Entity                                                                            | Target API                                           | Test Suite        | Evidence Tag |
| :---------------- | :---------------------------------------- | :------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------- | :--------------------------------------------------- | :---------------- | :----------- |
| **FR-BOOK-001**   | Unique human-readable booking reference   | Format `BK-YYYYMMDD-XXXX` (alphanumeric, unique, collision-resistant)                                   | `bookings.booking_reference`                                                               | `POST /api/v1/bookings`                              | `TEST-BOOK-001`   | [DOCUMENTED] |
| **FR-BOOK-002**   | Structured passenger schema validation    | Validate name, age-at-booking, gender, passenger type, and primary contact                              | `booking_passengers`                                                                       | `POST /api/v1/bookings`                              | `TEST-BOOK-002`   | [DOCUMENTED] |
| **FR-BOOK-003**   | Immutable historical snapshots            | Modifying catalogue package/price/itinerary/departure never alters past bookings                        | `bookings.package_snapshot`, `departure_snapshot`, `price_breakdown`, `itinerary_snapshot` | `POST /api/v1/bookings`, `GET /api/v1/bookings/:ref` | `TEST-BOOK-003`   | [DECISION]   |
| **FR-BOOK-004**   | Booking state initialization              | New bookings created in `AWAITING_PAYMENT` with 15-minute temporary hold                                | `bookings.status`, `inventory_holds`                                                       | `POST /api/v1/bookings`                              | `TEST-BOOK-004`   | [DOCUMENTED] |
| **FR-BOOK-005**   | Hold expiry & automatic release           | Unpaid holds expire after 15m; availability automatically restored; late payments cannot resurrect hold | `inventory_holds.status = 'EXPIRED'`, BullMQ Queue                                         | BullMQ Background Sweeper                            | `TEST-BOOK-005`   | [DOCUMENTED] |
| **FR-INVENT-004** | Temporary 15m seat reservation            | Derived availability strictly reserves seats under `SELECT ... FOR UPDATE`                              | `inventory_holds`, `departure_schedules`                                                   | `POST /api/v1/bookings`                              | `TEST-INVENT-004` | [DOCUMENTED] |
| **FR-INVENT-005** | Anti-overbooking concurrency guard        | PostgreSQL `CHECK (booked_seats <= total_seat_capacity)`                                                | `departure_schedules`                                                                      | `POST /api/v1/bookings`                              | `TEST-INVENT-005` | [DOCUMENTED] |
| **FR-DASH-001**   | Customer booking history                  | Customers can view their own past and upcoming bookings                                                 | `bookings WHERE customer_id = user.id`                                                     | `GET /api/v1/bookings`                               | `TEST-DASH-001`   | [DOCUMENTED] |
| **FR-DASH-002**   | Customer booking details                  | Object-level auth prevents viewing other customers' bookings (IDOR)                                     | `bookings`                                                                                 | `GET /api/v1/bookings/:ref`                          | `TEST-DASH-002`   | [DOCUMENTED] |
| **FR-DASH-004**   | Self-service booking cancellation         | Cancel unconfirmed or eligible bookings; atomic single-decrement inventory release                      | `bookings.status = 'CANCELLED'`                                                            | `POST /api/v1/bookings/:ref/cancel`                  | `TEST-DASH-004`   | [DOCUMENTED] |
| **FR-ADMIN-002**  | Admin booking search & audit ledger       | Admins can view and filter all platform bookings                                                        | `bookings`                                                                                 | `GET /api/v1/admin/bookings`                         | `TEST-ADMIN-002`  | [DOCUMENTED] |
| **FR-ADMIN-005**  | Departure passenger manifests             | Comprehensive manifest for guides and tour operators per departure                                      | `booking_passengers` JOIN `bookings`                                                       | `GET /api/v1/admin/departures/:id/manifest`          | `TEST-ADMIN-005`  | [DOCUMENTED] |
| **NFR-REL-001**   | Zero double-booking concurrency guarantee | Transactional pessimistic locks prevent overselling under high concurrency                              | `departure_schedules`, `inventory_holds`                                                   | All booking APIs                                     | `TEST-REL-001`    | [DOCUMENTED] |
| **NFR-SEC-004**   | Idempotency on payment & booking retries  | Unique `(user_id, endpoint_scope, idempotency_key)` prevents duplicates on retries                      | `idempotency_keys`                                                                         | `POST /api/v1/bookings`                              | `TEST-SEC-004`    | [DOCUMENTED] |

---

## 2. Evidence Tag Definitions

- `[DOCUMENTED]`: Formally defined in Phase 0 / Phase 4 engineering specifications.
- `[REPOSITORY]`: Inspected directly from current codebase implementation.
- `[DECISION]`: Formal architecture decision record (ADR).
- `[ASSUMPTION]`: Explicit engineering assumption stated for Phase 5.
- `[INFERENCE]`: Logical deduction from verified system constraints.
- `[UNKNOWN]`: Requires clarification or upstream decision.
- `[CONFLICT]`: Explicit conflict identified and resolved.
