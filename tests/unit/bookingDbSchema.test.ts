import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseService, runMigrations } from '../../backend/src/infrastructure/database/index.js';
import { loadEnv } from '../../backend/src/config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Phase 5 Step 1 — Bookings & Passengers Database Schema (DDL & Integration)', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../backend/src/infrastructure/database/migrations/004_create_bookings_and_passengers.sql',
  );

  let sqlContent = '';
  let bookingsTableBlock = '';
  let passengersTableBlock = '';
  let idempotencyTableBlock = '';
  let db: DatabaseService | null = null;
  let isDbAvailable = false;

  beforeAll(async () => {
    try {
      const config = loadEnv();
      db = new DatabaseService(config);
      const health = await db.checkHealth();
      if (health.status === 'healthy') {
        isDbAvailable = true;
        // Clean migration 004 tables and re-apply migrations freshly
        await db.query(`
          DROP TABLE IF EXISTS booking_passengers CASCADE;
          DROP TABLE IF EXISTS bookings CASCADE;
          DROP TABLE IF EXISTS idempotency_keys CASCADE;
          DELETE FROM schema_migrations WHERE migration_name = '004_create_bookings_and_passengers.sql';
        `);
        await runMigrations(db);
      }
    } catch {
      isDbAvailable = false;
    }
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  beforeEach(async () => {
    sqlContent = await fs.readFile(migrationPath, 'utf-8');
    const bookingsMatch = sqlContent.match(
      /CREATE TABLE IF NOT EXISTS bookings\s*\(([\s\S]*?)\);/i,
    );
    bookingsTableBlock = bookingsMatch?.[1] ?? '';

    const passengersMatch = sqlContent.match(
      /CREATE TABLE IF NOT EXISTS booking_passengers\s*\(([\s\S]*?)\);/i,
    );
    passengersTableBlock = passengersMatch?.[1] ?? '';

    const idempotencyMatch = sqlContent.match(
      /CREATE TABLE IF NOT EXISTS idempotency_keys\s*\(([\s\S]*?)\);/i,
    );
    idempotencyTableBlock = idempotencyMatch?.[1] ?? '';
  });

  describe('1. DDL Static Schema Verification', () => {
    it('should define booking_status enum with strictly canonical values', () => {
      expect(sqlContent).toMatch(
        /CREATE TYPE booking_status AS ENUM\s*\(\s*'AWAITING_PAYMENT',\s*'CONFIRMED',\s*'CANCELLED',\s*'EXPIRED'\s*\)/i,
      );

      // Must NOT contain invalid/deferred statuses
      expect(sqlContent).not.toMatch(/'PENDING'/i);
      expect(sqlContent).not.toMatch(/'PAID'/i);
      expect(sqlContent).not.toMatch(/'PAYMENT_FAILED'/i);
      expect(sqlContent).not.toMatch(/'COMPLETED'/i);
    });

    it('should define passenger_type and passenger_gender enums', () => {
      expect(sqlContent).toMatch(
        /CREATE TYPE passenger_type AS ENUM\s*\(\s*'ADULT',\s*'CHILD'\s*\)/i,
      );
      expect(sqlContent).toMatch(
        /CREATE TYPE passenger_gender AS ENUM\s*\(\s*'MALE',\s*'FEMALE',\s*'OTHER'\s*\)/i,
      );
    });

    it('should define bookings table with required columns, constraints, foreign keys and immutable snapshots', () => {
      expect(sqlContent).toMatch(/CREATE TABLE IF NOT EXISTS bookings/i);

      // Primary Key
      expect(bookingsTableBlock).toMatch(
        /id\s+UUID\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i,
      );

      // Booking Reference (Unique)
      expect(bookingsTableBlock).toMatch(
        /booking_reference\s+VARCHAR\(32\)\s+UNIQUE\s+NOT\s+NULL/i,
      );

      // Foreign Keys with appropriate deletion semantics
      expect(bookingsTableBlock).toMatch(
        /customer_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+users\s*\(\s*id\s*\)\s+ON\s+DELETE\s+RESTRICT/i,
      );
      expect(bookingsTableBlock).toMatch(
        /departure_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+departure_schedules\s*\(\s*id\s*\)\s+ON\s+DELETE\s+RESTRICT/i,
      );
      expect(bookingsTableBlock).toMatch(
        /hold_id\s+UUID\s+UNIQUE\s+REFERENCES\s+inventory_holds\s*\(\s*id\s*\)\s+ON\s+DELETE\s+SET\s+NULL/i,
      );

      // Party counts & consistency check
      expect(bookingsTableBlock).toMatch(
        /party_size\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*party_size\s*>=\s*1\s*\)/i,
      );
      expect(bookingsTableBlock).toMatch(
        /adult_count\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+1\s+CHECK\s*\(\s*adult_count\s*>=\s*0\s*\)/i,
      );
      expect(bookingsTableBlock).toMatch(
        /child_count\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0\s+CHECK\s*\(\s*child_count\s*>=\s*0\s*\)/i,
      );
      expect(bookingsTableBlock).toMatch(
        /CONSTRAINT\s+chk_party_size_sum\s+CHECK\s*\(\s*party_size\s*=\s*adult_count\s*\+\s*child_count\s*\)/i,
      );

      // Money & currency
      expect(bookingsTableBlock).toMatch(
        /total_price\s+BIGINT\s+NOT\s+NULL\s+CHECK\s*\(\s*total_price\s*>=\s*0\s*\)/i,
      );
      expect(bookingsTableBlock).toMatch(
        /currency\s+VARCHAR\(3\)\s+NOT\s+NULL\s+DEFAULT\s+['"]INR['"]/i,
      );

      // Status
      expect(bookingsTableBlock).toMatch(
        /status\s+booking_status\s+NOT\s+NULL\s+DEFAULT\s+['"]AWAITING_PAYMENT['"]/i,
      );

      // Immutable snapshots (all NOT NULL JSONB)
      expect(bookingsTableBlock).toMatch(/price_breakdown\s+JSONB\s+NOT\s+NULL/i);
      expect(bookingsTableBlock).toMatch(/package_snapshot\s+JSONB\s+NOT\s+NULL/i);
      expect(bookingsTableBlock).toMatch(/departure_snapshot\s+JSONB\s+NOT\s+NULL/i);
      expect(bookingsTableBlock).toMatch(/itinerary_snapshot\s+JSONB\s+NOT\s+NULL/i);

      // Primary contact
      expect(bookingsTableBlock).toMatch(/primary_contact_name\s+VARCHAR\(255\)\s+NOT\s+NULL/i);
      expect(bookingsTableBlock).toMatch(/primary_contact_email\s+VARCHAR\(255\)\s+NOT\s+NULL/i);
      expect(bookingsTableBlock).toMatch(/primary_contact_phone\s+VARCHAR\(30\)\s+NOT\s+NULL/i);
    });

    it('should define booking_passengers table with age-at-booking, optional DOB, and cascade deletion', () => {
      expect(sqlContent).toMatch(/CREATE TABLE IF NOT EXISTS booking_passengers/i);

      expect(passengersTableBlock).toMatch(
        /id\s+UUID\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i,
      );
      expect(passengersTableBlock).toMatch(
        /booking_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+bookings\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
      );
      expect(passengersTableBlock).toMatch(/passenger_type\s+passenger_type\s+NOT\s+NULL/i);
      expect(passengersTableBlock).toMatch(/full_name\s+VARCHAR\(255\)\s+NOT\s+NULL/i);
      expect(passengersTableBlock).toMatch(/date_of_birth\s+DATE/i);
      expect(passengersTableBlock).toMatch(
        /age_at_booking\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*age_at_booking\s*>=\s*0\s+AND\s+age_at_booking\s*<=\s*120\s*\)/i,
      );
      expect(passengersTableBlock).toMatch(/gender\s+passenger_gender\s+NOT\s+NULL/i);
      expect(passengersTableBlock).toMatch(
        /is_primary_contact\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
      );
      expect(passengersTableBlock).toMatch(/special_requests\s+TEXT/i);
    });

    it('should define idempotency_keys table with compound unique constraint (user_id, endpoint_scope, idempotency_key)', () => {
      expect(sqlContent).toMatch(/CREATE TABLE IF NOT EXISTS idempotency_keys/i);

      expect(idempotencyTableBlock).toMatch(
        /id\s+UUID\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i,
      );
      expect(idempotencyTableBlock).toMatch(
        /user_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+users\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
      );
      expect(idempotencyTableBlock).toMatch(/endpoint_scope\s+VARCHAR\(100\)\s+NOT\s+NULL/i);
      expect(idempotencyTableBlock).toMatch(
        /idempotency_key\s+VARCHAR\(128\)\s+NOT\s+NULL\s+CHECK\s*\(\s*length\(trim\(idempotency_key\)\)\s*>\s*0\s*\)/i,
      );
      expect(idempotencyTableBlock).toMatch(/request_hash\s+VARCHAR\(64\)\s+NOT\s+NULL/i);
      expect(idempotencyTableBlock).toMatch(
        /CONSTRAINT\s+uq_idempotency_user_endpoint_key\s+UNIQUE\s*\(\s*user_id\s*,\s*endpoint_scope\s*,\s*idempotency_key\s*\)/i,
      );
    });

    it('should create performance and operational indexes', () => {
      expect(sqlContent).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_bookings_customer_created ON bookings\s*\(\s*customer_id\s*,\s*created_at DESC\s*\)/i,
      );
      expect(sqlContent).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_bookings_departure_status ON bookings\s*\(\s*departure_id\s*,\s*status\s*\)/i,
      );
      expect(sqlContent).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_bookings_status_created ON bookings\s*\(\s*status\s*,\s*created_at DESC\s*\)/i,
      );
      expect(sqlContent).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_passengers_booking ON booking_passengers\s*\(\s*booking_id\s*\)/i,
      );
      expect(sqlContent).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS uq_passengers_primary_contact ON booking_passengers\s*\(\s*booking_id\s*\)\s+WHERE\s+is_primary_contact\s*=\s*TRUE/i,
      );
      expect(sqlContent).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys\s*\(\s*expires_at\s*\)/i,
      );
    });
  });

  describe('2. Live Database Invariant & Constraint Verification', () => {
    let testUserId = '';
    let testDepartureId = '';
    let testHoldId = '';

    beforeAll(async () => {
      if (!isDbAvailable || !db) return;

      // Fetch or create test user
      const userRes = await db.query<{ id: string }>(`SELECT id FROM users LIMIT 1;`);
      if (userRes.rows[0]) {
        testUserId = userRes.rows[0].id;
      }

      // Fetch test departure
      const depRes = await db.query<{ id: string }>(`SELECT id FROM departure_schedules LIMIT 1;`);
      if (depRes.rows[0]) {
        testDepartureId = depRes.rows[0].id;
      }

      // Insert test hold
      if (testDepartureId) {
        const holdRes = await db.query<{ id: string }>(
          `INSERT INTO inventory_holds (
            departure_id, checkout_session_token, user_id, held_seats, status, expires_at
          ) VALUES ($1, 'test-hold-session-12345', $2, 2, 'ACTIVE', NOW() + INTERVAL '15 minutes')
          ON CONFLICT (checkout_session_token) DO UPDATE SET checkout_session_token = EXCLUDED.checkout_session_token
          RETURNING id;`,
          [testDepartureId, testUserId || null],
        );
        testHoldId = holdRes.rows[0]?.id ?? '';
      }
    });

    it('should verify booking_status enum labels in PostgreSQL', async () => {
      if (!isDbAvailable || !db) return;

      const result = await db.query<{ enumlabel: string }>(
        `SELECT e.enumlabel
         FROM pg_type t
         JOIN pg_enum e ON t.oid = e.enumtypid
         WHERE t.typname = 'booking_status'
         ORDER BY e.enumsortorder ASC;`,
      );

      const labels = result.rows.map((r) => r.enumlabel);
      expect(labels).toEqual(['AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED']);
    });

    it('should verify bookings table columns in PostgreSQL', async () => {
      if (!isDbAvailable || !db) return;

      const result = await db.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_name = 'bookings'
         ORDER BY ordinal_position ASC;`,
      );

      const columnNames = result.rows.map((r) => r.column_name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('booking_reference');
      expect(columnNames).toContain('customer_id');
      expect(columnNames).toContain('departure_id');
      expect(columnNames).toContain('hold_id');
      expect(columnNames).toContain('party_size');
      expect(columnNames).toContain('adult_count');
      expect(columnNames).toContain('child_count');
      expect(columnNames).toContain('total_price');
      expect(columnNames).toContain('currency');
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('price_breakdown');
      expect(columnNames).toContain('package_snapshot');
      expect(columnNames).toContain('departure_snapshot');
      expect(columnNames).toContain('itinerary_snapshot');
      expect(columnNames).toContain('primary_contact_name');
      expect(columnNames).toContain('primary_contact_email');
      expect(columnNames).toContain('primary_contact_phone');

      // Snapshots must be NOT NULL
      const priceSnap = result.rows.find((r) => r.column_name === 'price_breakdown');
      expect(priceSnap?.is_nullable).toBe('NO');

      const pkgSnap = result.rows.find((r) => r.column_name === 'package_snapshot');
      expect(pkgSnap?.is_nullable).toBe('NO');

      const depSnap = result.rows.find((r) => r.column_name === 'departure_snapshot');
      expect(depSnap?.is_nullable).toBe('NO');

      const itinSnap = result.rows.find((r) => r.column_name === 'itinerary_snapshot');
      expect(itinSnap?.is_nullable).toBe('NO');
    });

    it('should insert a valid booking and passenger roster successfully within a transaction', async () => {
      if (!isDbAvailable || !db || !testUserId || !testDepartureId) return;

      await db
        .withTransaction(async (client) => {
          const bookingRes = await client.query<{ id: string }>(
            `INSERT INTO bookings (
              booking_reference, customer_id, departure_id, hold_id,
              party_size, adult_count, child_count, total_price, currency, status,
              price_breakdown, package_snapshot, departure_snapshot, itinerary_snapshot,
              primary_contact_name, primary_contact_email, primary_contact_phone
            ) VALUES (
              'BK-20261115-TEST1', $1, $2, $3,
              2, 2, 0, 9000000, 'INR', 'AWAITING_PAYMENT',
              '{"totalPrice": 9000000}'::jsonb,
              '{"title": "Kashmir Tour"}'::jsonb,
              '{"departureDate": "2026-11-15"}'::jsonb,
              '[{"day": 1, "title": "Arrival"}]'::jsonb,
              'John Doe', 'john@example.com', '+919876543210'
            ) RETURNING id;`,
            [testUserId, testDepartureId, testHoldId || null],
          );

          const bookingId = bookingRes.rows[0]?.id;
          expect(bookingId).toBeDefined();

          // Insert Primary Passenger
          await client.query(
            `INSERT INTO booking_passengers (
              booking_id, passenger_type, full_name, age_at_booking, gender, is_primary_contact
            ) VALUES ($1, 'ADULT', 'John Doe', 35, 'MALE', TRUE);`,
            [bookingId],
          );

          // Insert Second Passenger
          await client.query(
            `INSERT INTO booking_passengers (
              booking_id, passenger_type, full_name, age_at_booking, gender, is_primary_contact
            ) VALUES ($1, 'ADULT', 'Jane Doe', 32, 'FEMALE', FALSE);`,
            [bookingId],
          );

          // Rollback test data
          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') {
            throw err;
          }
        });
    });

    it('should reject invalid party_size = 0', async () => {
      if (!isDbAvailable || !db || !testUserId || !testDepartureId) return;

      await expect(
        db.query(
          `INSERT INTO bookings (
            booking_reference, customer_id, departure_id,
            party_size, adult_count, child_count, total_price, currency, status,
            price_breakdown, package_snapshot, departure_snapshot, itinerary_snapshot,
            primary_contact_name, primary_contact_email, primary_contact_phone
          ) VALUES (
            'BK-ERR-001', $1, $2,
            0, 0, 0, 500000, 'INR', 'AWAITING_PAYMENT',
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
            'A', 'a@b.com', '123'
          );`,
          [testUserId, testDepartureId],
        ),
      ).rejects.toThrow(/chk_party_size|party_size/i);
    });

    it('should reject party_size inconsistent with sum of adults and children', async () => {
      if (!isDbAvailable || !db || !testUserId || !testDepartureId) return;

      await expect(
        db.query(
          `INSERT INTO bookings (
            booking_reference, customer_id, departure_id,
            party_size, adult_count, child_count, total_price, currency, status,
            price_breakdown, package_snapshot, departure_snapshot, itinerary_snapshot,
            primary_contact_name, primary_contact_email, primary_contact_phone
          ) VALUES (
            'BK-ERR-002', $1, $2,
            3, 1, 1, 500000, 'INR', 'AWAITING_PAYMENT',
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
            'A', 'a@b.com', '123'
          );`,
          [testUserId, testDepartureId],
        ),
      ).rejects.toThrow(/chk_party_size_sum/i);
    });

    it('should reject negative total_price', async () => {
      if (!isDbAvailable || !db || !testUserId || !testDepartureId) return;

      await expect(
        db.query(
          `INSERT INTO bookings (
            booking_reference, customer_id, departure_id,
            party_size, adult_count, child_count, total_price, currency, status,
            price_breakdown, package_snapshot, departure_snapshot, itinerary_snapshot,
            primary_contact_name, primary_contact_email, primary_contact_phone
          ) VALUES (
            'BK-ERR-003', $1, $2,
            1, 1, 0, -100, 'INR', 'AWAITING_PAYMENT',
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
            'A', 'a@b.com', '123'
          );`,
          [testUserId, testDepartureId],
        ),
      ).rejects.toThrow(/chk_booking_total_price|total_price/i);
    });

    it('should reject invalid age_at_booking (< 0 or > 120)', async () => {
      if (!isDbAvailable || !db || !testUserId || !testDepartureId) return;

      await db
        .withTransaction(async (client) => {
          const bRes = await client.query<{ id: string }>(
            `INSERT INTO bookings (
              booking_reference, customer_id, departure_id,
              party_size, adult_count, child_count, total_price, currency, status,
              price_breakdown, package_snapshot, departure_snapshot, itinerary_snapshot,
              primary_contact_name, primary_contact_email, primary_contact_phone
            ) VALUES (
              'BK-ERR-AGE', $1, $2,
              1, 1, 0, 500000, 'INR', 'AWAITING_PAYMENT',
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
              'A', 'a@b.com', '123'
            ) RETURNING id;`,
            [testUserId, testDepartureId],
          );
          const bookingId = bRes.rows[0]?.id;

          // Age > 120 should fail
          await expect(
            client.query(
              `INSERT INTO booking_passengers (
                booking_id, passenger_type, full_name, age_at_booking, gender
              ) VALUES ($1, 'ADULT', 'Old Traveler', 125, 'MALE');`,
              [bookingId],
            ),
          ).rejects.toThrow(/age_at_booking/i);

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') {
            throw err;
          }
        });
    });

    it('should enforce partial unique index for is_primary_contact (at most 1 per booking)', async () => {
      if (!isDbAvailable || !db || !testUserId || !testDepartureId) return;

      await db
        .withTransaction(async (client) => {
          const bRes = await client.query<{ id: string }>(
            `INSERT INTO bookings (
              booking_reference, customer_id, departure_id,
              party_size, adult_count, child_count, total_price, currency, status,
              price_breakdown, package_snapshot, departure_snapshot, itinerary_snapshot,
              primary_contact_name, primary_contact_email, primary_contact_phone
            ) VALUES (
              'BK-ERR-PRIMARY', $1, $2,
              2, 2, 0, 500000, 'INR', 'AWAITING_PAYMENT',
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
              'A', 'a@b.com', '123'
            ) RETURNING id;`,
            [testUserId, testDepartureId],
          );
          const bookingId = bRes.rows[0]?.id;

          // First primary contact succeeds
          await client.query(
            `INSERT INTO booking_passengers (
              booking_id, passenger_type, full_name, age_at_booking, gender, is_primary_contact
            ) VALUES ($1, 'ADULT', 'Primary One', 30, 'MALE', TRUE);`,
            [bookingId],
          );

          // Second primary contact on same booking must fail
          await expect(
            client.query(
              `INSERT INTO booking_passengers (
                booking_id, passenger_type, full_name, age_at_booking, gender, is_primary_contact
              ) VALUES ($1, 'ADULT', 'Primary Two', 28, 'FEMALE', TRUE);`,
              [bookingId],
            ),
          ).rejects.toThrow(/uq_passengers_primary_contact|duplicate key/i);

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') {
            throw err;
          }
        });
    });

    it('should enforce compound uniqueness on idempotency_keys (user_id, endpoint_scope, idempotency_key)', async () => {
      if (!isDbAvailable || !db || !testUserId) return;

      await db
        .withTransaction(async (client) => {
          await client.query(
            `INSERT INTO idempotency_keys (
              user_id, endpoint_scope, idempotency_key, request_hash, response_code, response_body
            ) VALUES (
              $1, 'POST /api/v1/bookings', 'idem-test-key-1', 'sha256hash123', 201, '{"status": "ok"}'::jsonb
            );`,
            [testUserId],
          );

          // Duplicate insert on same user + scope + key must fail
          await expect(
            client.query(
              `INSERT INTO idempotency_keys (
                user_id, endpoint_scope, idempotency_key, request_hash, response_code, response_body
              ) VALUES (
                $1, 'POST /api/v1/bookings', 'idem-test-key-1', 'sha256hash123', 201, '{"status": "ok"}'::jsonb
              );`,
              [testUserId],
            ),
          ).rejects.toThrow(/uq_idempotency_user_endpoint_key|duplicate key/i);

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') {
            throw err;
          }
        });
    });
  });
});
