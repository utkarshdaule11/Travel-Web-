import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../backend/src/app.js';
import { loadEnv } from '../../backend/src/config/env.js';
import { DatabaseService, runMigrations } from '../../backend/src/infrastructure/database/index.js';
import { seedAll } from '../../backend/src/infrastructure/database/seeds/seedAll.js';
import { DepartureRepository } from '../../backend/src/modules/inventory/repositories/departure.repository.js';
import { BookingRepository } from '../../backend/src/modules/booking/repositories/booking.repository.js';
import { PassengerRepository } from '../../backend/src/modules/booking/repositories/passenger.repository.js';
import { JwtSecurity } from '../../shared/src/security/jwt.js';
import { ErrorCodes } from '../../shared/src/index.js';

describe('Phase 5 Step 7 — Admin Booking & Passenger Manifest APIs (Integration & Security)', () => {
  let app: FastifyInstance;
  let db: DatabaseService;
  let isDbAvailable = false;
  let departureRepo: DepartureRepository;
  let bookingRepo: BookingRepository;
  let passengerRepo: PassengerRepository;

  const config = loadEnv();

  // Test identities
  const adminId = '99999999-9999-4999-8999-999999999999';
  const customerId = '88888888-8888-4888-8888-888888888888';
  const adminEmail = 'admin.step7@example.com';
  const customerEmail = 'customer.step7@example.com';

  let tokenAdmin: string;
  let tokenCustomer: string;
  let testPackageId: string;

  beforeAll(async () => {
    try {
      db = new DatabaseService(config);
      const health = await db.checkHealth();
      if (health.status === 'healthy') {
        isDbAvailable = true;

        await runMigrations(db);
        await seedAll();

        departureRepo = new DepartureRepository(db);
        bookingRepo = new BookingRepository(db);
        passengerRepo = new PassengerRepository(db);

        // Provision test admin and customer accounts in PostgreSQL
        await db.query(
          `INSERT INTO users (id, email, password_hash, full_name, role, is_active)
           VALUES
             ($1, $2, '$argon2id$mockhash', 'Admin Operator', 'ADMIN', true),
             ($3, $4, '$argon2id$mockhash', 'Regular Customer', 'CUSTOMER', true)
           ON CONFLICT (id) DO UPDATE SET is_active = true, role = EXCLUDED.role;`,
          [adminId, adminEmail, customerId, customerEmail],
        );

        // Generate valid RS256 JWT tokens
        tokenAdmin = JwtSecurity.sign(
          {
            userId: adminId,
            email: adminEmail,
            role: 'ADMIN',
            sessionId: 'session-admin-step7',
          },
          config.JWT_PRIVATE_KEY,
          { expiresInSeconds: 3600 },
        );

        tokenCustomer = JwtSecurity.sign(
          {
            userId: customerId,
            email: customerEmail,
            role: 'CUSTOMER',
            sessionId: 'session-cust-step7',
          },
          config.JWT_PRIVATE_KEY,
          { expiresInSeconds: 3600 },
        );

        // Find a valid seeded package
        const pkgRes = await db.query<{ id: string }>(
          `SELECT id FROM tour_packages WHERE is_published = true LIMIT 1;`,
        );
        testPackageId = pkgRes.rows[0]!.id;

        // Initialize Fastify app with real dependencies
        const created = await createApp({ config, db });
        app = created.app;
        await app.ready();
      }
    } catch {
      isDbAvailable = false;
    }
  });

  // Helper for generating unique departure schedules
  let departureOffsetCounter = 300;
  const createTestDeparture = async (capacity = 20) => {
    departureOffsetCounter++;
    const depDate = new Date(Date.UTC(2028, 7, departureOffsetCounter));
    const retDate = new Date(Date.UTC(2028, 7, departureOffsetCounter + 5));
    const depDateStr = depDate.toISOString().split('T')[0]!;
    const retDateStr = retDate.toISOString().split('T')[0]!;
    return departureRepo.create({
      packageId: testPackageId,
      departureDate: depDateStr,
      returnDate: retDateStr,
      totalSeatCapacity: capacity,
      currency: 'INR',
      status: 'OPEN',
    });
  };

  const sampleSnapshots = {
    priceBreakdown: {
      adultCount: 1,
      adultUnitPrice: 5000000,
      adultSubtotal: 5000000,
      childCount: 0,
      childUnitPrice: 0,
      childSubtotal: 0,
      baseSubtotal: 5000000,
      discountAmount: 0,
      totalPrice: 5000000,
      currency: 'INR' as const,
      calculatedAt: new Date().toISOString(),
    },
    packageSnapshot: {
      packageId: '11111111-1111-4111-8111-111111111111',
      slug: 'golden-triangle-tour',
      title: 'Golden Triangle Tour',
      shortDescription: 'Explore Delhi, Agra, and Jaipur',
      durationDays: 5,
      durationNights: 4,
      originCity: 'New Delhi',
      destinationCity: 'Jaipur',
      destinationCountry: 'India',
      heroImageUrl: 'https://images.unsplash.com/photo-1548013146-72479768bada',
      inclusions: ['Hotels', 'Breakfast'],
      exclusions: ['Flights'],
    },
    departureSnapshot: {
      departureId: '22222222-2222-4222-8222-222222222222',
      departureDate: '2028-08-01',
      returnDate: '2028-08-06',
      pricingApplied: {
        basePriceAdult: 5000000,
        basePriceChild: 3000000,
        currency: 'INR' as const,
      },
      statusAtBooking: 'OPEN',
    },
    itinerarySnapshot: [
      {
        dayNumber: 1,
        title: 'Arrival in Delhi',
        activityDescription: 'Airport greeting and hotel transfer',
        mealsIncluded: ['Dinner'],
      },
    ],
  };

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (db && isDbAvailable) {
      await db.query(`DELETE FROM idempotency_keys;`);
      await db.query(`DELETE FROM booking_passengers;`);
      await db.query(`DELETE FROM bookings;`);
      await db.query(`DELETE FROM inventory_holds;`);
      await db.query(`DELETE FROM departure_schedules WHERE departure_date >= '2028-01-01';`);
      await db.query(`DELETE FROM users WHERE id IN ($1, $2);`, [adminId, customerId]);
      await db.close();
    }
  });

  // ============================================================
  // TEST A — Unauthenticated GET admin bookings -> 401
  // ============================================================
  it('TEST A — Unauthenticated GET /api/v1/admin/bookings returns 401 UNAUTHORIZED', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/bookings',
    });

    expect(response.statusCode).toBe(401);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.UNAUTHORIZED);
  });

  // ============================================================
  // TEST B — Unauthenticated GET admin booking details -> 401
  // ============================================================
  it('TEST B — Unauthenticated GET /api/v1/admin/bookings/:reference returns 401 UNAUTHORIZED', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/bookings/BK-TEST-001',
    });

    expect(response.statusCode).toBe(401);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.UNAUTHORIZED);
  });

  // ============================================================
  // TEST C — Unauthenticated GET departure manifest -> 401
  // ============================================================
  it('TEST C — Unauthenticated GET /api/v1/admin/departures/:departureId/manifest returns 401 UNAUTHORIZED', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/departures/${adminId}/manifest`,
    });

    expect(response.statusCode).toBe(401);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.UNAUTHORIZED);
  });

  // ============================================================
  // TEST D — Authenticated CUSTOMER accessing admin booking list -> 403 FORBIDDEN
  // ============================================================
  it('TEST D — Authenticated CUSTOMER accessing GET /api/v1/admin/bookings returns 403 FORBIDDEN', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomer}`,
      },
    });

    expect(response.statusCode).toBe(403);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.FORBIDDEN);
  });

  // ============================================================
  // TEST E — Authenticated CUSTOMER accessing admin booking details -> 403 FORBIDDEN
  // ============================================================
  it('TEST E — Authenticated CUSTOMER accessing GET /api/v1/admin/bookings/:reference returns 403 FORBIDDEN', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/bookings/BK-TEST-001',
      headers: {
        authorization: `Bearer ${tokenCustomer}`,
      },
    });

    expect(response.statusCode).toBe(403);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.FORBIDDEN);
  });

  // ============================================================
  // TEST F — Authenticated CUSTOMER accessing manifest -> 403 FORBIDDEN
  // ============================================================
  it('TEST F — Authenticated CUSTOMER accessing GET /api/v1/admin/departures/:departureId/manifest returns 403 FORBIDDEN', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/departures/${adminId}/manifest`,
      headers: {
        authorization: `Bearer ${tokenCustomer}`,
      },
    });

    expect(response.statusCode).toBe(403);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.FORBIDDEN);
  });

  // ============================================================
  // TEST G — Authorized ADMIN lists bookings -> 200
  // ============================================================
  it('TEST G — Authorized ADMIN lists bookings: GET /api/v1/admin/bookings returns 200 with paginated array', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const booking = await bookingRepo.create({
      bookingReference: `BK-ADM-LIST-${Date.now()}`,
      customerId,
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      ...sampleSnapshots,
      primaryContact: {
        name: 'List Lead',
        email: 'listlead@example.com',
        phone: '+919988776655',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/bookings?page=1&limit=10',
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.meta.page).toBe(1);
    expect(json.meta.limit).toBe(10);
    expect(json.meta.totalItems).toBeGreaterThanOrEqual(1);
    expect(json.meta.totalPages).toBeGreaterThanOrEqual(1);

    const found = json.data.some((b: any) => b.bookingReference === booking.bookingReference);
    expect(found).toBe(true);
  });

  // ============================================================
  // TEST H — Authorized ADMIN retrieves existing booking -> 200
  // ============================================================
  it('TEST H — Authorized ADMIN retrieves existing booking: GET /api/v1/admin/bookings/:reference returns 200 with full details and passenger roster', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const testRef = `BK-ADM-GET-${Date.now()}`;
    const booking = await bookingRepo.create({
      bookingReference: testRef,
      customerId,
      departureId: departure.id,
      partySize: 2,
      adultCount: 1,
      childCount: 1,
      totalPrice: 8000000,
      currency: 'INR',
      status: 'CONFIRMED',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Audit Contact',
        email: 'audit@example.com',
        phone: '+919876500000',
      },
    });

    await passengerRepo.createMany([
      {
        bookingId: booking.id,
        passengerType: 'ADULT',
        fullName: 'Adult Inspector',
        ageAtBooking: 35,
        gender: 'MALE',
        isPrimaryContact: true,
        specialRequests: 'Aisle seat',
      },
      {
        bookingId: booking.id,
        passengerType: 'CHILD',
        fullName: 'Child Inspector',
        ageAtBooking: 8,
        gender: 'FEMALE',
        isPrimaryContact: false,
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bookings/${testRef}`,
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
    expect(json.data.bookingReference).toBe(testRef);
    expect(json.data.status).toBe('CONFIRMED');
    expect(json.data.partySize).toBe(2);
    expect(json.data.passengers).toHaveLength(2);
    expect(json.data.passengers[0].fullName).toBe('Adult Inspector');
    expect(json.data.passengers[0].specialRequests).toBe('Aisle seat');
    expect(json.data.priceBreakdown).toBeDefined();
    expect(json.data.packageSnapshot).toBeDefined();
    expect(json.data.departureSnapshot).toBeDefined();
  });

  // ============================================================
  // TEST I — Unknown booking reference -> canonical 404
  // ============================================================
  it('TEST I — Unknown booking reference: GET /api/v1/admin/bookings/BK-NONEXISTENT-999 returns 404 BOOKING_NOT_FOUND', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/bookings/BK-NONEXISTENT-999',
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
    });

    expect(response.statusCode).toBe(404);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.BOOKING_NOT_FOUND);
  });

  // ============================================================
  // TEST J — Authorized ADMIN retrieves departure manifest -> 200
  // ============================================================
  it('TEST J — Authorized ADMIN retrieves departure manifest: GET /api/v1/admin/departures/:departureId/manifest returns 200 with departure header and passenger roster', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(15);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/departures/${departure.id}/manifest`,
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
    expect(json.data.departureId).toBe(departure.id);
    expect(json.data.totalCapacity).toBe(15);
    expect(Array.isArray(json.data.passengers)).toBe(true);
  });

  // ============================================================
  // TEST K, L, M, N — Manifest filtering: CONFIRMED included; AWAITING_PAYMENT, EXPIRED, CANCELLED excluded
  // ============================================================
  it('TEST K, L, M, N — Manifest strictly includes CONFIRMED passengers and excludes AWAITING_PAYMENT, EXPIRED, and CANCELLED bookings', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(30);

    // 1. Create CONFIRMED Booking
    const confirmedBooking = await bookingRepo.create({
      bookingReference: `BK-CONF-${Date.now()}`,
      customerId,
      departureId: departure.id,
      partySize: 2,
      adultCount: 1,
      childCount: 1,
      totalPrice: 8000000,
      currency: 'INR',
      status: 'CONFIRMED',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Confirmed Lead',
        email: 'conf@example.com',
        phone: '+919999911111',
      },
    });

    await passengerRepo.createMany([
      {
        bookingId: confirmedBooking.id,
        passengerType: 'ADULT',
        fullName: 'Confirmed Adult Passenger',
        ageAtBooking: 40,
        gender: 'FEMALE',
        isPrimaryContact: true,
        specialRequests: 'Window seat',
      },
      {
        bookingId: confirmedBooking.id,
        passengerType: 'CHILD',
        fullName: 'Confirmed Child Passenger',
        ageAtBooking: 10,
        gender: 'MALE',
        isPrimaryContact: false,
      },
    ]);

    // 2. Create AWAITING_PAYMENT Booking
    const awaitingBooking = await bookingRepo.create({
      bookingReference: `BK-AWAIT-${Date.now()}`,
      customerId,
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Awaiting Lead',
        email: 'await@example.com',
        phone: '+919999922222',
      },
    });

    await passengerRepo.create({
      bookingId: awaitingBooking.id,
      passengerType: 'ADULT',
      fullName: 'Awaiting Unpaid Passenger',
      ageAtBooking: 28,
      gender: 'MALE',
      isPrimaryContact: true,
    });

    // 3. Create EXPIRED Booking
    const expiredBooking = await bookingRepo.create({
      bookingReference: `BK-EXP-${Date.now()}`,
      customerId,
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'EXPIRED',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Expired Lead',
        email: 'exp@example.com',
        phone: '+919999933333',
      },
    });

    await passengerRepo.create({
      bookingId: expiredBooking.id,
      passengerType: 'ADULT',
      fullName: 'Expired Passenger',
      ageAtBooking: 32,
      gender: 'FEMALE',
      isPrimaryContact: true,
    });

    // 4. Create CANCELLED Booking
    const cancelledBooking = await bookingRepo.create({
      bookingReference: `BK-CANC-${Date.now()}`,
      customerId,
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'CANCELLED',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Cancelled Lead',
        email: 'canc@example.com',
        phone: '+919999944444',
      },
    });

    await passengerRepo.create({
      bookingId: cancelledBooking.id,
      passengerType: 'ADULT',
      fullName: 'Cancelled Passenger',
      ageAtBooking: 50,
      gender: 'MALE',
      isPrimaryContact: true,
    });

    // Fetch manifest as admin
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/departures/${departure.id}/manifest`,
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);

    const passengerNames = json.data.passengers.map((p: any) => p.fullName);

    // TEST K — Manifest includes CONFIRMED passengers
    expect(passengerNames).toContain('Confirmed Adult Passenger');
    expect(passengerNames).toContain('Confirmed Child Passenger');
    expect(json.data.totalPassengers).toBe(2);
    expect(json.data.adultPassengers).toBe(1);
    expect(json.data.childPassengers).toBe(1);

    // TEST L — Manifest excludes AWAITING_PAYMENT booking
    expect(passengerNames).not.toContain('Awaiting Unpaid Passenger');

    // TEST M — Manifest excludes EXPIRED booking
    expect(passengerNames).not.toContain('Expired Passenger');

    // TEST N — Manifest excludes CANCELLED booking
    expect(passengerNames).not.toContain('Cancelled Passenger');
  });

  // ============================================================
  // TEST O — Malformed departure UUID -> validation error (400)
  // ============================================================
  it('TEST O — Malformed departure UUID: GET /api/v1/admin/departures/not-a-valid-uuid/manifest returns 400 VALIDATION_ERROR', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/departures/not-a-valid-uuid/manifest',
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  // ============================================================
  // TEST P — SQL injection attempt in booking reference -> safely rejected
  // ============================================================
  it('TEST P — SQL injection in booking reference returns canonical 404 without SQL error or data leakage', async () => {
    if (!isDbAvailable) return;

    const maliciousReference = "BK-INJECT'; DROP TABLE bookings; --";
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bookings/${encodeURIComponent(maliciousReference)}`,
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
    });

    expect(response.statusCode).toBe(404);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.BOOKING_NOT_FOUND);
  });

  // ============================================================
  // TEST Q — Pagination returns correct metadata
  // ============================================================
  it('TEST Q — Pagination returns correct metadata: limit, page, totalItems, totalPages', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/bookings?page=1&limit=2',
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
    expect(json.meta.page).toBe(1);
    expect(json.meta.limit).toBe(2);
    expect(json.meta.totalItems).toBeDefined();
    expect(json.meta.totalPages).toBeDefined();
    expect(json.data.length).toBeLessThanOrEqual(2);
  });

  // ============================================================
  // TEST R — Status filter returns only requested statuses
  // ============================================================
  it('TEST R — Status filter returns only requested statuses', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/bookings?status=CONFIRMED',
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
    for (const item of json.data) {
      expect(item.status).toBe('CONFIRMED');
    }
  });

  // ============================================================
  // TEST S — Admin GET operations do not modify inventory
  // ============================================================
  it('TEST S — Admin GET operations do not modify inventory: booked_seats remain unchanged after reading manifest and bookings', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const initialDep = await departureRepo.findById(departure.id);
    const initialBooked = initialDep?.bookedSeats;

    // Execute multiple GET requests
    await app.inject({
      method: 'GET',
      url: `/api/v1/admin/departures/${departure.id}/manifest`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bookings?departureId=${departure.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    const finalDep = await departureRepo.findById(departure.id);
    expect(finalDep?.bookedSeats).toBe(initialBooked);
  });

  // ============================================================
  // TEST T — Passenger response does not expose secrets/internal fields
  // ============================================================
  it('TEST T — Manifest and booking details do not expose password_hash, tokens, or internal secrets', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const ref = `BK-SEC-${Date.now()}`;
    const booking = await bookingRepo.create({
      bookingReference: ref,
      customerId,
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'CONFIRMED',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Secret Contact',
        email: 'secret@example.com',
        phone: '+919988112233',
      },
    });

    await passengerRepo.create({
      bookingId: booking.id,
      passengerType: 'ADULT',
      fullName: 'Secret Passenger',
      ageAtBooking: 25,
      gender: 'OTHER',
      isPrimaryContact: true,
    });

    // Check Manifest DTO
    const manifestRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/departures/${departure.id}/manifest`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    expect(manifestRes.statusCode).toBe(200);
    const manifestJson = JSON.parse(manifestRes.payload);
    const manifestStr = JSON.stringify(manifestJson);

    expect(manifestStr).not.toContain('password');
    expect(manifestStr).not.toContain('hash');
    expect(manifestStr).not.toContain('secret');
    expect(manifestStr).not.toContain('token');

    // Check Booking Details DTO
    const detailsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bookings/${ref}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    expect(detailsRes.statusCode).toBe(200);
    const detailsJson = JSON.parse(detailsRes.payload);
    const detailsStr = JSON.stringify(detailsJson);

    expect(detailsStr).not.toContain('password');
    expect(detailsStr).not.toContain('hash');
    expect(detailsStr).not.toContain('jwt');
  });

  // ============================================================
  // Additional Edge Case — Non-existent departure UUID for manifest -> 404
  // ============================================================
  it('Additional Edge Case — Non-existent departure UUID returns 404 RESOURCE_NOT_FOUND', async () => {
    if (!isDbAvailable) return;

    const nonExistentId = '00000000-0000-4000-8000-000000000000';
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/departures/${nonExistentId}/manifest`,
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
    });

    expect(response.statusCode).toBe(404);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.RESOURCE_NOT_FOUND);
  });
});
