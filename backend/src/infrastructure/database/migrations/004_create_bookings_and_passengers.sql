-- Migration: 004_create_bookings_and_passengers.sql
-- Description: Create bookings, booking_passengers, and idempotency_keys tables with strict constraints, enums, snapshots, and indexes for Phase 5.

-- 1. Booking Status Enum (Canonical Booking Lifecycle)
DO $$ BEGIN
    CREATE TYPE booking_status AS ENUM ('AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 2. Passenger Type Enum
DO $$ BEGIN
    CREATE TYPE passenger_type AS ENUM ('ADULT', 'CHILD');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 3. Passenger Gender Enum
DO $$ BEGIN
    CREATE TYPE passenger_gender AS ENUM ('MALE', 'FEMALE', 'OTHER');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 4. Bookings Table (DR-007 Booking Engine & Snapshots)
CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_reference VARCHAR(32) UNIQUE NOT NULL, -- e.g. BK-20261115-A8F2
    customer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    departure_id UUID NOT NULL REFERENCES departure_schedules(id) ON DELETE RESTRICT,
    hold_id UUID UNIQUE REFERENCES inventory_holds(id) ON DELETE SET NULL,

    party_size INTEGER NOT NULL CHECK (party_size >= 1),
    adult_count INTEGER NOT NULL DEFAULT 1 CHECK (adult_count >= 0),
    child_count INTEGER NOT NULL DEFAULT 0 CHECK (child_count >= 0),

    total_price BIGINT NOT NULL CHECK (total_price >= 0), -- Minor units (e.g. paise / cents)
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    status booking_status NOT NULL DEFAULT 'AWAITING_PAYMENT',

    -- Immutable historical snapshots
    price_breakdown JSONB NOT NULL,
    package_snapshot JSONB NOT NULL,
    departure_snapshot JSONB NOT NULL,
    itinerary_snapshot JSONB NOT NULL,

    -- Primary Contact Information
    primary_contact_name VARCHAR(255) NOT NULL,
    primary_contact_email VARCHAR(255) NOT NULL,
    primary_contact_phone VARCHAR(30) NOT NULL,

    -- Lifecycle & Audit Metadata
    cancellation_reason TEXT,
    cancelled_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_party_size_sum CHECK (party_size = adult_count + child_count)
);

-- 5. Booking Passengers Table (Passenger Roster & Age-at-Booking)
CREATE TABLE IF NOT EXISTS booking_passengers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

    passenger_type passenger_type NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    date_of_birth DATE, -- Optional historical DOB
    age_at_booking INTEGER NOT NULL CHECK (age_at_booking >= 0 AND age_at_booking <= 120),
    gender passenger_gender NOT NULL,

    is_primary_contact BOOLEAN NOT NULL DEFAULT FALSE,
    special_requests TEXT, -- General non-sensitive travel preferences

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Idempotency Keys Table (Checkout & State-Mutation Safety)
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint_scope VARCHAR(100) NOT NULL, -- e.g. 'POST /api/v1/bookings', 'POST /api/v1/bookings/:ref/cancel'
    idempotency_key VARCHAR(128) NOT NULL CHECK (length(trim(idempotency_key)) > 0),
    request_hash VARCHAR(64) NOT NULL, -- SHA-256 of canonical request payload
    response_code INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),

    CONSTRAINT uq_idempotency_user_endpoint_key UNIQUE (user_id, endpoint_scope, idempotency_key)
);

-- 7. Performance & Query Indexes
CREATE INDEX IF NOT EXISTS idx_bookings_customer_created ON bookings (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_departure_status ON bookings (departure_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_status_created ON bookings (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_passengers_booking ON booking_passengers (booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_passengers_primary_contact ON booking_passengers (booking_id) WHERE is_primary_contact = TRUE;
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);
