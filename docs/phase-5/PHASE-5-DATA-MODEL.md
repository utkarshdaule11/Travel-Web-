# Phase 5 — Booking Engine Data Model & Database Architecture

**Project:** Young Tours & Travels  
**Phase:** 5 — Booking Engine  
**Document:** Database Schema, Tables, Constraints & Snapshot Schema  
**Status:** **STEP 0 — PLANNING (DOCUMENTATION-ONLY • NO CODE)** [DOCUMENTED]

---

## 1. Relational Schema Architecture

```
                    ┌───────────────────────────┐
                    │      tour_packages        │
                    └─────────────┬─────────────┘
                                  │
                                  v
┌─────────────────┐ 1   * ┌─────────────────────┐ 1   * ┌───────────────────┐
│     users       ├──────►│ departure_schedules ├──────►│  inventory_holds  │
└────────┬────────┘       └──────────┬──────────┘       └───────────────────┘
         │                           │
         │ 1                         │ 1
         │                           │
         │ *                         │ *
         └─────────────►┌────────────▼──────────────┐
                        │         bookings          │
                        └────────────┬──────────────┘
                                     │ 1
                                     │
                                     │ *
                        ┌────────────▼──────────────┐
                        │    booking_passengers     │
                        └───────────────────────────┘
```

---

## 2. Table Specifications

### 2.1 `bookings` Table

```sql
CREATE TYPE booking_status AS ENUM (
    'AWAITING_PAYMENT',
    'CONFIRMED',
    'CANCELLED',
    'EXPIRED'
);

CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_reference VARCHAR(20) UNIQUE NOT NULL, -- e.g. BK-20261115-A8F2
    customer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    departure_id UUID NOT NULL REFERENCES departure_schedules(id) ON DELETE RESTRICT,
    hold_id UUID REFERENCES inventory_holds(id) ON DELETE SET NULL,

    party_size INTEGER NOT NULL CHECK (party_size >= 1),
    adult_count INTEGER NOT NULL DEFAULT 1 CHECK (adult_count >= 0),
    child_count INTEGER NOT NULL DEFAULT 0 CHECK (child_count >= 0),

    total_price BIGINT NOT NULL CHECK (total_price >= 0), -- Minor units (paise/cents)
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    status booking_status NOT NULL DEFAULT 'AWAITING_PAYMENT',

    -- Immutable historical snapshots
    price_breakdown JSONB NOT NULL,
    package_snapshot JSONB NOT NULL,
    departure_snapshot JSONB NOT NULL,
    itinerary_snapshot JSONB NOT NULL,

    primary_contact_name VARCHAR(120) NOT NULL,
    primary_contact_email VARCHAR(255) NOT NULL,
    primary_contact_phone VARCHAR(30) NOT NULL,

    cancellation_reason TEXT,
    cancelled_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_party_size_sum CHECK (party_size = adult_count + child_count)
);

CREATE INDEX idx_bookings_customer_created ON bookings (customer_id, created_at DESC);
CREATE INDEX idx_bookings_departure_status ON bookings (departure_id, status);
CREATE INDEX idx_bookings_status_created ON bookings (status, created_at DESC);
```

---

### 2.2 `booking_passengers` Table

```sql
CREATE TYPE passenger_type AS ENUM ('ADULT', 'CHILD');
CREATE TYPE passenger_gender AS ENUM ('MALE', 'FEMALE', 'OTHER');

CREATE TABLE booking_passengers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

    passenger_type passenger_type NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    date_of_birth DATE, -- Optional historical DOB
    age_at_booking INTEGER NOT NULL CHECK (age_at_booking >= 0 AND age_at_booking <= 120),
    gender passenger_gender NOT NULL,

    is_primary_contact BOOLEAN NOT NULL DEFAULT FALSE,
    special_requests TEXT, -- General non-sensitive travel preferences

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_passengers_booking ON booking_passengers (booking_id);
```

---

### 2.3 `idempotency_keys` Table (Checkout & Mutation Safety)

```sql
CREATE TABLE idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint_scope VARCHAR(100) NOT NULL, -- e.g. 'POST /api/v1/bookings', 'POST /api/v1/bookings/:ref/cancel'
    idempotency_key VARCHAR(128) NOT NULL,
    request_hash VARCHAR(64) NOT NULL, -- SHA-256 of canonical request payload
    response_code INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),

    CONSTRAINT uq_idempotency_user_endpoint_key UNIQUE (user_id, endpoint_scope, idempotency_key)
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys (expires_at);
```

---

## 3. Snapshot Data Schemas

### 3.1 `price_breakdown` (JSONB)

```json
{
  "adultCount": 2,
  "adultUnitPrice": 4500000,
  "adultSubtotal": 9000000,
  "childCount": 1,
  "childUnitPrice": 2250000,
  "childSubtotal": 2250000,
  "baseSubtotal": 11250000,
  "discountAmount": 0,
  "totalPrice": 11250000,
  "currency": "INR",
  "calculatedAt": "2026-09-26T05:45:00.000Z"
}
```

### 3.2 `package_snapshot` (JSONB)

```json
{
  "packageId": "11111111-1111-1111-1111-111111111111",
  "slug": "kashmir-delight-tour",
  "title": "Kashmir Delight Tour",
  "shortDescription": "6 Days in paradise with Shikara ride and Gulmarg Gondola.",
  "durationDays": 6,
  "durationNights": 5,
  "originCity": "Delhi",
  "destinationCity": "Srinagar",
  "destinationCountry": "India",
  "heroImageUrl": "https://images.unsplash.com/photo-kashmir.jpg",
  "inclusions": ["Houseboat Stay", "Daily Breakfast & Dinner", "Shikara Ride"],
  "exclusions": ["Airfare", "Personal Expenses"],
  "accommodationTier": "STANDARD",
  "mealPlan": "FULL_BOARD"
}
```

### 3.3 `departure_snapshot` (JSONB)

```json
{
  "departureId": "22222222-2222-2222-2222-222222222222",
  "departureDate": "2026-11-15",
  "returnDate": "2026-11-20",
  "pricingApplied": {
    "basePriceAdult": 4500000,
    "basePriceChild": 2250000,
    "singleSupplementPrice": 0,
    "currency": "INR"
  },
  "statusAtBooking": "OPEN"
}
```

### 3.4 `itinerary_snapshot` (JSONB)

```json
[
  {
    "dayNumber": 1,
    "title": "Arrival in Srinagar & Dal Lake",
    "activityDescription": "Airport pickup, transfer to Houseboat, sunset Shikara ride on Dal Lake.",
    "mealsIncluded": ["DINNER"],
    "accommodationNotes": "Deluxe Houseboat"
  },
  {
    "dayNumber": 2,
    "title": "Gulmarg Day Trip & Gondola",
    "activityDescription": "Full day excursion to Gulmarg with Gondola cable car phase 1 & 2.",
    "mealsIncluded": ["BREAKFAST", "DINNER"],
    "accommodationNotes": "Deluxe Houseboat"
  }
]
```

---

## 4. Architectural Decisions

### 4.1 Evaluation of `booking_items`

- **Decision:** A dedicated `booking_items` table is **NOT required for MVP**. [DECISION]
- **Rationale:** In Young Tours & Travels, each booking represents a direct purchase of a single tour package departure for a specific passenger roster (`1:1` relationship between booking and departure). Introducing an intermediate line-item table at this stage creates premature abstraction and unnecessary database joins without adding business value. If multi-item shopping carts, flight add-ons, or custom merchandise are introduced in future phases, a line-item schema migration can be evaluated then.

### 4.2 Passenger Age Stability vs. Historical Integrity

- **Decision:** The passenger model records `age_at_booking INTEGER` and optional `date_of_birth DATE`. [DECISION]
- **Rationale:** Storing `age_at_booking` ensures that adult/child ticket pricing and passenger classifications remain historically immutable and reproducible forever, even if passenger rosters are inspected years after the tour.
