# Phase 5 — Booking & Inventory Hold State Machine Specification

**Project:** Young Tours & Travels  
**Phase:** 5 — Booking Engine  
**Document:** State Machine & Lifecycle Transitions  
**Status:** **STEP 0 — PLANNING (DOCUMENTATION-ONLY • NO CODE)** [DOCUMENTED]

---

## 1. Booking State Machine

```
              ┌────────────────────────────────────────────────────────┐
              │                                                        │
              │  [1. POST /api/v1/bookings]                            │
              │  Reserve 15m Temporary Seat Hold                       │
              │                                                        │
              └───────────────────────────┬────────────────────────────┘
                                          │
                                          v
                         ┌─────────────────────────────────┐
                         │                                 │
                         │       AWAITING_PAYMENT          │
                         │   (Hold Active in DB Ledger)    │
                         │                                 │
                         └───┬─────────────┬─────────────┬─┘
                             │             │             │
  [2. Payment Success (Phase 6)]  [3. 15m Timeout]  [4. Customer Cancel]
  Hold Committed             │   Hold Expired    │   Hold Released
  booked_seats += partySize  │                   │
                             v                   v               v
             ┌───────────────────────┐   ┌───────────────┐ ┌───────────────┐
             │                       │   │               │ │               │
             │       CONFIRMED       │   │    EXPIRED    │ │   CANCELLED   │
             │     (Stable State)    │   │(Terminal/Dead)│ │(Terminal/Void)│
             │                       │   │               │ │               │
             └───────────┬───────────┘   └───────────────┘ └───────────────┘
                         │
                         │ [5. Customer / Admin Cancel]
                         │ Release booked_seats -= partySize
                         v
             ┌───────────────────────┐
             │                       │
             │       CANCELLED       │
             │   (Terminal State)    │
             │                       │
             └───────────────────────┘
```

---

## 2. State Definitions & Matrix

| State Name             | Type         | Entry Condition                              | Inventory Effect                                                                             | Payment Meaning                  | Customer Visibility                               | Admin Visibility                               |
| :--------------------- | :----------- | :------------------------------------------- | :------------------------------------------------------------------------------------------- | :------------------------------- | :------------------------------------------------ | :--------------------------------------------- |
| **`AWAITING_PAYMENT`** | Non-Terminal | Booking created via `POST /bookings`         | Seats held via `inventory_holds` for 15 min                                                  | Unpaid; checkout session active  | Visible as "Pending Payment" with countdown timer | Visible in Active Checkout Monitor             |
| **`CONFIRMED`**        | Stable       | Payment successfully captured & verified [1] | Seats permanently committed to `booked_seats`                                                | Paid in full                     | Visible as "Confirmed"; manifest eligible         | Visible on departure manifest & booking ledger |
| **`CANCELLED`**        | Terminal     | Customer or Admin cancel action executed     | If hold active $\rightarrow$ Released; if confirmed $\rightarrow$ `booked_seats` decremented | Refund policy applied in Phase 6 | Visible as "Cancelled"                            | Visible in audit trail & cancellations ledger  |
| **`EXPIRED`**          | Terminal     | 15 minutes elapsed without payment           | Hold marked expired; seats released to public                                                | No payment received              | Visible as "Session Expired"                      | Filtered out of active rosters                 |

> [!IMPORTANT]
> **[1] Frozen Business Rule (No Unbacked Confirmations):** A booking transitions to `CONFIRMED` **only** upon verified successful payment (via Phase 6 payment webhook / integration hooks). No unbacked administrative manual overrides to `CONFIRMED` are permitted without payment verification.

---

## 3. Transition Table & Strict Invariants

| Current State      | Triggering Event               | Target State       | Invariants & Business Logic Enforced                                                                   | Inventory Effect                                                                    |
| :----------------- | :----------------------------- | :----------------- | :----------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| _None_             | `CUSTOMER_INITIATE_CHECKOUT`   | `AWAITING_PAYMENT` | - $partySize \ge 1$<br>- `availableSeats >= partySize`<br>- Passenger roster valid                     | Insert `ACTIVE` hold with `expires_at = NOW() + 15m`                                |
| `AWAITING_PAYMENT` | `PAYMENT_CAPTURED` _(Phase 6)_ | `CONFIRMED`        | - Hold must be strictly `ACTIVE` and `expires_at > NOW()` [2]<br>- Payment amount matches total        | `booked_seats += partySize`<br>Hold status $\rightarrow$ `COMMITTED`                |
| `AWAITING_PAYMENT` | `HOLD_TIMEOUT_EXPIRED`         | `EXPIRED`          | - 15 minutes elapsed without payment confirmation                                                      | Hold status $\rightarrow$ `EXPIRED`<br>Seats immediately available                  |
| `AWAITING_PAYMENT` | `CUSTOMER_ABANDON_CHECKOUT`    | `CANCELLED`        | - User explicitly cancels checkout session                                                             | Hold status $\rightarrow$ `RELEASED`<br>Seats immediately available                 |
| `CONFIRMED`        | `CUSTOMER_CANCEL_BOOKING`      | `CANCELLED`        | - Departure is in the future<br>- Atomic state transition guard: `WHERE status = 'CONFIRMED'` [3]      | `booked_seats -= partySize` (exactly once)<br>Seats returned to public availability |
| `CONFIRMED`        | `ADMIN_CANCEL_BOOKING`         | `CANCELLED`        | - Mandatory admin reason provided<br>- Atomic state transition guard: `WHERE status = 'CONFIRMED'` [3] | `booked_seats -= partySize` (exactly once)<br>Seats returned to public availability |

---

## 4. Critical Invariants

### [2] Late Payment After Hold Expiry Policy

An expired hold **cannot** be resurrected into a confirmed booking:

- **`ACTIVE` hold + valid payment:** $\rightarrow$ `CONFIRMED` (Hold marked `COMMITTED`, `booked_seats += party_size`).
- **`EXPIRED` hold + late payment:** $\rightarrow$ **DO NOT automatically confirm**. The booking remains `EXPIRED`. Phase 6 payment reconciliation processes the orphaned payment and triggers automated refund / customer support escalation. An expired hold is never resurrected, preventing race conditions against other customers who booked released seats.

### [3] Cancellation Atomicity & Double-Decrement Guard

To prevent duplicate cancellations or network retry races from corrupting inventory:

- Transition from `CONFIRMED` to `CANCELLED` is guarded by an atomic SQL update:
  ```sql
  UPDATE bookings
  SET status = 'CANCELLED', cancelled_at = NOW(), cancellation_reason = $1
  WHERE id = $2 AND status = 'CONFIRMED'
  RETURNING *;
  ```
- `booked_seats = booked_seats - $party_size` executes **only if** the update returned a row.
- If the booking was already `CANCELLED`, 0 rows are updated, no inventory decrement executes, and the API returns `BOOKING_ALREADY_CANCELLED` (or the cached idempotent response). `booked_seats` is decremented **strictly once**.

---

## 5. Inventory Hold Lifecycle State Machine

```
              ┌──────────────────────────────────────────────────┐
              │                                                  │
              │  [Hold Created in POST /api/v1/bookings]         │
              │                                                  │
              └────────────────────────┬─────────────────────────┘
                                       │
                                       v
                             ┌────────────────────┐
                             │       ACTIVE       │
                             │ (expires_at > NOW) │
                             └───┬─────┬────────┬─┘
                                 │     │        │
                   ┌─────────────┘     │        └──────────────┐
                   │ (Payment Success) │ (15m Timeout)         │ (User Cancel)
                   v                   v                       v
         ┌───────────────────┐ ┌───────────────┐     ┌───────────────────┐
         │     COMMITTED     │ │    EXPIRED    │     │     RELEASED      │
         │ (Seats in DB row) │ │(Zero impact)  │     │(Restored to public│
         └───────────────────┘ └───────────────┘     └───────────────────┘
```

1. **`ACTIVE`**: Hold counts against available capacity in the derived availability formula.
2. **`COMMITTED`**: Hold is converted into permanent `booked_seats` on `departure_schedules`. Does not count as temporary hold.
3. **`EXPIRED`**: Hold timestamp has passed (`expires_at <= NOW()`). Formula automatically excludes it; background worker marks row as `EXPIRED`.
4. **`RELEASED`**: Explicitly voided prior to expiration. Formula immediately reflects restored capacity.
