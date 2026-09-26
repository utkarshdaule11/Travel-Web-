import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../backend/src/app.js';
import { loadEnv } from '../../backend/src/config/env.js';
import { DatabaseService, runMigrations } from '../../backend/src/infrastructure/database/index.js';
import { seedAll } from '../../backend/src/infrastructure/database/seeds/seedAll.js';
import { DepartureRepository } from '../../backend/src/modules/inventory/repositories/departure.repository.js';
import { InventoryHoldRepository } from '../../backend/src/modules/inventory/repositories/inventoryHold.repository.js';
import { BookingRepository } from '../../backend/src/modules/booking/repositories/booking.repository.js';
import { PassengerRepository } from '../../backend/src/modules/booking/repositories/passenger.repository.js';
import { BookingService } from '../../backend/src/modules/booking/services/booking.service.js';
import { AvailabilityService } from '../../backend/src/modules/inventory/services/availability.service.js';
import { JwtSecurity } from '../../shared/src/security/jwt.js';
import { ErrorCodes } from '../../shared/src/index.js';

describe('Phase 5 Step 9 — Booking Engine Final Integration & Hardening (Complete Matrix A–Z)', () => {
  let app: FastifyInstance;
  let db: DatabaseService;
  let isDbAvailable = false;
  let departureRepo: DepartureRepository;
  let holdRepo: InventoryHoldRepository;
  let bookingRepo: BookingRepository;
  let passengerRepo: PassengerRepository;
  let bookingService: BookingService;
  let availabilityService: AvailabilityService;

  const config = loadEnv();

  // Test identities
  const customerIdA = '44444444-4444-4444-8444-444444444444';
  const customerIdB = '55555555-5555-4555-8555-555555555555';
  const adminId = '66666666-6666-4666-8666-666666666666';

  const emailA = 'cust.a.step9@example.com';
  const emailB = 'cust.b.step9@example.com';
  const adminEmail = 'admin.step9@example.com';

  let tokenA: string;
  let tokenB: string;
  let tokenAdmin: string;
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
        holdRepo = new InventoryHoldRepository(db);
        bookingRepo = new BookingRepository(db);
        passengerRepo = new PassengerRepository(db);
        availabilityService = new AvailabilityService(departureRepo);

        // Provision accounts in PostgreSQL
        await db.query(
          `INSERT INTO users (id, email, password_hash, full_name, role, is_active)
           VALUES
             ($1, $2, '$argon2id$mockhash', 'Customer Alpha', 'CUSTOMER', true),
             ($3, $4, '$argon2id$mockhash', 'Customer Beta', 'CUSTOMER', true),
             ($5, $6, '$argon2id$mockhash', 'Admin Operator', 'ADMIN', true)
           ON CONFLICT (id) DO UPDATE SET is_active = true, role = EXCLUDED.role;`,
          [customerIdA, emailA, customerIdB, emailB, adminId, adminEmail],
        );

        // Generate RS256 JWT tokens
        tokenA = JwtSecurity.sign(
          { userId: customerIdA, email: emailA, role: 'CUSTOMER', sessionId: 'sess-a' },
          config.JWT_PRIVATE_KEY,
          { expiresInSeconds: 3600 },
        );

        tokenB = JwtSecurity.sign(
          { userId: customerIdB, email: emailB, role: 'CUSTOMER', sessionId: 'sess-b' },
          config.JWT_PRIVATE_KEY,
          { expiresInSeconds: 3600 },
        );

        tokenAdmin = JwtSecurity.sign(
          { userId: adminId, email: adminEmail, role: 'ADMIN', sessionId: 'sess-adm' },
          config.JWT_PRIVATE_KEY,
          { expiresInSeconds: 3600 },
        );

        const pkgRes = await db.query<{ id: string }>(
          `SELECT id FROM tour_packages WHERE is_published = true LIMIT 1;`,
        );
        testPackageId = pkgRes.rows[0]!.id;

        const created = await createApp({ config, db });
        app = created.app;
        bookingService = created.bookingService;
        await app.ready();
      }
    } catch {
      isDbAvailable = false;
    }
  });

  let departureOffsetCounter = 700;
  const createTestDeparture = async (capacity = 20) => {
    departureOffsetCounter++;
    const depDate = new Date(Date.UTC(2028, 11, departureOffsetCounter));
    const retDate = new Date(Date.UTC(2028, 11, departureOffsetCounter + 5));
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
      shortDescription: 'Delhi Agra Jaipur',
      durationDays: 5,
      durationNights: 4,
      originCity: 'New Delhi',
      destinationCity: 'Jaipur',
      destinationCountry: 'India',
      heroImageUrl: 'https://images.unsplash.com/photo-1548013146-72479768bada',
      inclusions: ['Hotels'],
      exclusions: ['Flights'],
    },
    departureSnapshot: {
      departureId: '22222222-2222-4222-8222-222222222222',
      departureDate: '2028-10-01',
      returnDate: '2028-10-05',
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
        title: 'Arrival',
        activityDescription: 'Airport greeting',
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
      await db.query(`DELETE FROM users WHERE id IN ($1, $2, $3);`, [
        customerIdA,
        customerIdB,
        adminId,
      ]);
      await db.close();
    }
  });

  // ============================================================
  // TEST A — Customer creates valid booking -> 201 + AWAITING_PAYMENT + ACTIVE hold
  // ============================================================
  it('TEST A — Customer creates valid booking: returns 201 with AWAITING_PAYMENT and 15-min ACTIVE hold', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const idemKey = crypto.randomUUID();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenA}`,
        'idempotency-key': idemKey,
      },
      payload: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Lead Passenger',
            ageAtBooking: 32,
            gender: 'MALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'Second Passenger',
            ageAtBooking: 30,
            gender: 'FEMALE',
            isPrimaryContact: false,
          },
        ],
        primaryContact: {
          name: 'Lead Passenger',
          email: 'lead@example.com',
          phone: '+919876543210',
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('AWAITING_PAYMENT');
    expect(json.data.partySize).toBe(2);
    expect(json.data.holdId).toBeDefined();
    expect(json.data.holdExpiresAt).toBeDefined();
    expect(json.data.bookingReference).toMatch(/^BK-\d{8}-[A-F0-9]{4}$/);
    expect(json.data.passengers).toHaveLength(2);
    expect(json.meta.isReplay).toBe(false);
  });

  // ============================================================
  // TEST B — Same request repeated with same idempotency key -> original response
  // ============================================================
  it('TEST B — Repeated request with identical idempotency key returns cached response without duplicate hold', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const idemKey = crypto.randomUUID();

    const payload = {
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      passengers: [
        {
          passengerType: 'ADULT',
          fullName: 'Solo Traveler',
          ageAtBooking: 28,
          gender: 'MALE',
          isPrimaryContact: true,
        },
      ],
      primaryContact: {
        name: 'Solo Traveler',
        email: 'solo@example.com',
        phone: '+919988776655',
      },
    };

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': idemKey },
      payload,
    });

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': idemKey },
      payload,
    });

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);

    const json1 = JSON.parse(res1.payload);
    const json2 = JSON.parse(res2.payload);

    expect(json2.data.bookingReference).toBe(json1.data.bookingReference);
    expect(json2.meta.isReplay).toBe(true);

    // Verify only 1 hold was created in DB
    const holds = await holdRepo.listByDepartureId(departure.id);
    expect(holds).toHaveLength(1);
  });

  // ============================================================
  // TEST C — Same idempotency key with modified body -> 409 IDEMPOTENCY_CONFLICT
  // ============================================================
  it('TEST C — Same idempotency key with modified payload throws 409 IDEMPOTENCY_CONFLICT', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const idemKey = crypto.randomUUID();

    const basePayload = {
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      passengers: [
        {
          passengerType: 'ADULT',
          fullName: 'Idem Passenger',
          ageAtBooking: 25,
          gender: 'MALE',
          isPrimaryContact: true,
        },
      ],
      primaryContact: {
        name: 'Idem Passenger',
        email: 'idem@example.com',
        phone: '+919988776655',
      },
    };

    await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': idemKey },
      payload: basePayload,
    });

    // Send with altered passenger name
    const conflictRes = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': idemKey },
      payload: {
        ...basePayload,
        passengers: [{ ...basePayload.passengers[0]!, fullName: 'Altered Name' }],
      },
    });

    expect(conflictRes.statusCode).toBe(409);
    const json = JSON.parse(conflictRes.payload);
    expect(json.error.code).toBe(ErrorCodes.IDEMPOTENCY_CONFLICT);
  });

  // ============================================================
  // TEST D — Insufficient inventory -> booking rejected
  // ============================================================
  it('TEST D — Booking requesting more seats than available capacity is rejected', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(2); // Only 2 seats capacity

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': crypto.randomUUID() },
      payload: {
        departureId: departure.id,
        partySize: 4, // Requests 4 seats > 2 capacity
        adultCount: 4,
        childCount: 0,
        passengers: [1, 2, 3, 4].map((i) => ({
          passengerType: 'ADULT',
          fullName: `Passenger ${i}`,
          ageAtBooking: 30,
          gender: 'MALE',
          isPrimaryContact: i === 1,
        })),
        primaryContact: {
          name: 'Lead Passenger',
          email: 'lead@example.com',
          phone: '+919988776655',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.error.code).toBe(ErrorCodes.INVENTORY_CAPACITY_EXCEEDED);
  });

  // ============================================================
  // TEST E — Expired hold -> booking and hold both become EXPIRED
  // ============================================================
  it('TEST E — Expiring hold transitions booking to EXPIRED and hold to EXPIRED without touching booked_seats', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-exp-${Date.now()}`,
      userId: customerIdA,
      heldSeats: 2,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 5000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-E-${Date.now()}`,
      customerId: customerIdA,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: { name: 'E Lead', email: 'e@example.com', phone: '+919988776655' },
    });

    const result = await bookingService.expireHoldAndBooking(hold.id, booking.id);
    expect(result.outcome).toBe('EXPIRED');

    const updatedBooking = await bookingRepo.findById(booking.id);
    const updatedHold = await holdRepo.findById(hold.id);
    const updatedDep = await departureRepo.findById(departure.id);

    expect(updatedBooking?.status).toBe('EXPIRED');
    expect(updatedHold?.status).toBe('EXPIRED');
    expect(updatedDep?.bookedSeats).toBe(0);
  });

  // ============================================================
  // TEST F — Successful payment confirmation -> CONFIRMED + COMMITTED + increments booked_seats
  // ============================================================
  it('TEST F — Payment confirmation: transitions booking to CONFIRMED, hold to COMMITTED, and increments booked_seats once', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-conf-${Date.now()}`,
      userId: customerIdA,
      heldSeats: 3,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-F-${Date.now()}`,
      customerId: customerIdA,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 3,
      adultCount: 3,
      childCount: 0,
      totalPrice: 15000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: { name: 'F Lead', email: 'f@example.com', phone: '+919988776655' },
    });

    const confirmed = await bookingService.confirmBooking({
      bookingId: booking.id,
      paymentVerified: true,
    });

    expect(confirmed.status).toBe('CONFIRMED');

    const updatedHold = await holdRepo.findById(hold.id);
    const updatedDep = await departureRepo.findById(departure.id);

    expect(updatedHold?.status).toBe('COMMITTED');
    expect(updatedDep?.bookedSeats).toBe(3);
  });

  // ============================================================
  // TEST G — Expired booking cannot be confirmed
  // ============================================================
  it('TEST G — Late payment on an EXPIRED booking/hold cannot confirm booking (Late Payment Invariant)', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-late-${Date.now()}`,
      userId: customerIdA,
      heldSeats: 2,
      status: 'EXPIRED',
      expiresAt: new Date(Date.now() - 60000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-G-${Date.now()}`,
      customerId: customerIdA,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'EXPIRED',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: { name: 'G Lead', email: 'g@example.com', phone: '+919988776655' },
    });

    await expect(
      bookingService.confirmBooking({ bookingId: booking.id, paymentVerified: true }),
    ).rejects.toThrowError();

    const checkDep = await departureRepo.findById(departure.id);
    expect(checkDep?.bookedSeats).toBe(0);
  });

  // ============================================================
  // TEST H — Confirmed booking cannot be expired
  // ============================================================
  it('TEST H — Confirmed booking cannot be expired by background worker (returns COMMITTED no-op)', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-h-${Date.now()}`,
      userId: customerIdA,
      heldSeats: 2,
      status: 'COMMITTED',
      expiresAt: new Date(Date.now() + 10000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-H-${Date.now()}`,
      customerId: customerIdA,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'CONFIRMED',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: { name: 'H Lead', email: 'h@example.com', phone: '+919988776655' },
    });

    const result = await bookingService.expireHoldAndBooking(hold.id, booking.id);
    expect(result.outcome).toBe('COMMITTED');

    const checkBooking = await bookingRepo.findById(booking.id);
    expect(checkBooking?.status).toBe('CONFIRMED');
  });

  // ============================================================
  // TEST I — Confirmed booking cancellation -> CANCELLED + decrements booked_seats once
  // ============================================================
  it('TEST I — Confirmed booking cancellation: transitions to CANCELLED and decrements booked_seats strictly once', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const ref = `BK-I-${Date.now()}`;

    // Create confirmed booking with 2 booked seats
    await db.query(`UPDATE departure_schedules SET booked_seats = 2 WHERE id = $1;`, [
      departure.id,
    ]);

    await bookingRepo.create({
      bookingReference: ref,
      customerId: customerIdA,
      departureId: departure.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'CONFIRMED',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: { name: 'I Lead', email: 'i@example.com', phone: '+919988776655' },
    });

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${ref}/cancel`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { reason: 'Schedule conflict' },
    });

    expect(cancelRes.statusCode).toBe(200);
    const json = JSON.parse(cancelRes.payload);
    expect(json.data.status).toBe('CANCELLED');

    const checkDep = await departureRepo.findById(departure.id);
    expect(checkDep?.bookedSeats).toBe(0); // 2 - 2 = 0
  });

  // ============================================================
  // TEST J — Cancelled booking cannot be cancelled again
  // ============================================================
  it('TEST J — Cancelled booking cannot be cancelled again (returns 400 BOOKING_ALREADY_CANCELLED)', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const ref = `BK-J-${Date.now()}`;

    await bookingRepo.create({
      bookingReference: ref,
      customerId: customerIdA,
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'CANCELLED',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: { name: 'J Lead', email: 'j@example.com', phone: '+919988776655' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${ref}/cancel`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.error.code).toBe(ErrorCodes.BOOKING_ALREADY_CANCELLED);
  });

  // ============================================================
  // TEST K — Customer cannot access another customer's booking (IDOR guard)
  // ============================================================
  it('TEST K — Customer B accessing Customer A booking returns 404 BOOKING_NOT_FOUND (IDOR protection)', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const ref = `BK-K-${Date.now()}`;

    await bookingRepo.create({
      bookingReference: ref,
      customerId: customerIdA, // Owned by A
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: { name: 'K Lead', email: 'k@example.com', phone: '+919988776655' },
    });

    // Customer B attempts access
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${ref}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(response.statusCode).toBe(404);
    const json = JSON.parse(response.payload);
    expect(json.error.code).toBe(ErrorCodes.BOOKING_NOT_FOUND);
  });

  // ============================================================
  // TEST L — Customer cannot access admin endpoints
  // ============================================================
  it('TEST L — Authenticated customer accessing admin endpoints receives 403 FORBIDDEN', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/bookings',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(response.statusCode).toBe(403);
    const json = JSON.parse(response.payload);
    expect(json.error.code).toBe(ErrorCodes.FORBIDDEN);
  });

  // ============================================================
  // TEST M — Admin can access admin booking endpoints
  // ============================================================
  it('TEST M — Authorized admin can list and inspect bookings (200 OK)', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/bookings?page=1&limit=5',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.meta.page).toBe(1);
  });

  // ============================================================
  // TEST N — Manifest contains only CONFIRMED passengers
  // ============================================================
  it('TEST N — Departure manifest strictly contains CONFIRMED passengers only', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(20);

    // 1. Confirmed booking
    const bConfirmed = await bookingRepo.create({
      bookingReference: `BK-MAN-CONF-${Date.now()}`,
      customerId: customerIdA,
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'CONFIRMED',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: {
        name: 'Confirmed Traveler',
        email: 'conf@example.com',
        phone: '+919988776655',
      },
    });

    await passengerRepo.create({
      bookingId: bConfirmed.id,
      passengerType: 'ADULT',
      fullName: 'Manifest Confirmed Passenger',
      ageAtBooking: 35,
      gender: 'MALE',
      isPrimaryContact: true,
    });

    // 2. Awaiting Payment booking
    const bAwaiting = await bookingRepo.create({
      bookingReference: `BK-MAN-AWAIT-${Date.now()}`,
      customerId: customerIdA,
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: {
        name: 'Awaiting Traveler',
        email: 'await@example.com',
        phone: '+919988776655',
      },
    });

    await passengerRepo.create({
      bookingId: bAwaiting.id,
      passengerType: 'ADULT',
      fullName: 'Manifest Unpaid Passenger',
      ageAtBooking: 29,
      gender: 'FEMALE',
      isPrimaryContact: true,
    });

    const manifestRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/departures/${departure.id}/manifest`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    expect(manifestRes.statusCode).toBe(200);
    const json = JSON.parse(manifestRes.payload);

    const passengerNames = json.data.passengers.map((p: any) => p.fullName);
    expect(passengerNames).toContain('Manifest Confirmed Passenger');
    expect(passengerNames).not.toContain('Manifest Unpaid Passenger');
  });

  // ============================================================
  // TEST O — Concurrent booking requests do not overbook
  // ============================================================
  it('TEST O — 5 concurrent booking requests for remaining 2 seats: exactly 1 succeeds, 4 safely rejected', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(2); // Capacity = 2

    const createPayload = () => ({
      departureId: departure.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      passengers: [
        {
          passengerType: 'ADULT',
          fullName: 'Adult 1',
          ageAtBooking: 30,
          gender: 'MALE',
          isPrimaryContact: true,
        },
        {
          passengerType: 'ADULT',
          fullName: 'Adult 2',
          ageAtBooking: 28,
          gender: 'FEMALE',
          isPrimaryContact: false,
        },
      ],
      primaryContact: { name: 'Adult 1', email: 'a1@example.com', phone: '+919988776655' },
    });

    const requests = Array.from({ length: 5 }, () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/bookings',
        headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': crypto.randomUUID() },
        payload: createPayload(),
      }),
    );

    const responses = await Promise.all(requests);
    const successCount = responses.filter((r) => r.statusCode === 201).length;
    const failureCount = responses.filter((r) => r.statusCode === 400).length;

    expect(successCount).toBe(1);
    expect(failureCount).toBe(4);

    const activeHolds = await holdRepo.getActiveHoldCountForDeparture(departure.id);
    expect(activeHolds).toBe(2);
  });

  // ============================================================
  // TEST P — Concurrent confirmation requests increment booked_seats once
  // ============================================================
  it('TEST P — Concurrent confirmation calls on the same booking increment booked_seats strictly once', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-p-${Date.now()}`,
      userId: customerIdA,
      heldSeats: 2,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-P-${Date.now()}`,
      customerId: customerIdA,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: { name: 'P Lead', email: 'p@example.com', phone: '+919988776655' },
    });

    await Promise.all([
      bookingService.confirmBooking({ bookingId: booking.id, paymentVerified: true }),
      bookingService.confirmBooking({ bookingId: booking.id, paymentVerified: true }),
    ]);

    const checkDep = await departureRepo.findById(departure.id);
    expect(checkDep?.bookedSeats).toBe(2); // Incremented strictly once (not 4)
  });

  // ============================================================
  // TEST Q — Confirmation vs expiry produces only valid atomic outcome
  // ============================================================
  it('TEST Q — Confirmation vs Expiry race produces strictly valid atomic state', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-q-${Date.now()}`,
      userId: customerIdA,
      heldSeats: 2,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 200),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-Q-${Date.now()}`,
      customerId: customerIdA,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: { name: 'Q Lead', email: 'q@example.com', phone: '+919988776655' },
    });

    await Promise.allSettled([
      bookingService.confirmBooking({ bookingId: booking.id, paymentVerified: true }),
      bookingService.expireHoldAndBooking(hold.id, booking.id),
    ]);

    const checkBooking = await bookingRepo.findById(booking.id);
    const checkHold = await holdRepo.findById(hold.id);

    const isValidOutcome =
      (checkBooking?.status === 'CONFIRMED' && checkHold?.status === 'COMMITTED') ||
      (checkBooking?.status === 'EXPIRED' && checkHold?.status === 'EXPIRED');

    expect(isValidOutcome).toBe(true);
  });

  // ============================================================
  // TEST R — Concurrent cancellation does not double-decrement
  // ============================================================
  it('TEST R — Concurrent cancellation calls decrement booked_seats strictly once', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const ref = `BK-R-${Date.now()}`;

    await db.query(`UPDATE departure_schedules SET booked_seats = 3 WHERE id = $1;`, [
      departure.id,
    ]);

    await bookingRepo.create({
      bookingReference: ref,
      customerId: customerIdA,
      departureId: departure.id,
      partySize: 3,
      adultCount: 3,
      childCount: 0,
      totalPrice: 15000000,
      currency: 'INR',
      status: 'CONFIRMED',
      priceBreakdown: { ...sampleSnapshots.priceBreakdown },
      packageSnapshot: { ...sampleSnapshots.packageSnapshot },
      departureSnapshot: { ...sampleSnapshots.departureSnapshot },
      itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
      primaryContact: { name: 'R Lead', email: 'r@example.com', phone: '+919988776655' },
    });

    await Promise.allSettled([
      bookingService.cancelBooking({ bookingReference: ref, customerId: customerIdA }),
      bookingService.cancelBooking({ bookingReference: ref, customerId: customerIdA }),
    ]);

    const checkDep = await departureRepo.findById(departure.id);
    expect(checkDep?.bookedSeats).toBe(0); // 3 - 3 = 0 (not negative)
  });

  // ============================================================
  // TEST S — Transaction failure rolls back booking + hold changes
  // ============================================================
  it('TEST S — Transaction failure rolls back booking and hold atomically', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const ref = `BK-S-${Date.now()}`;

    try {
      await db.withTransaction(async (client: pg.PoolClient) => {
        await bookingRepo.create(
          {
            bookingReference: ref,
            customerId: customerIdA,
            departureId: departure.id,
            partySize: 1,
            adultCount: 1,
            childCount: 0,
            totalPrice: 5000000,
            currency: 'INR',
            status: 'AWAITING_PAYMENT',
            priceBreakdown: { ...sampleSnapshots.priceBreakdown },
            packageSnapshot: { ...sampleSnapshots.packageSnapshot },
            departureSnapshot: { ...sampleSnapshots.departureSnapshot },
            itinerarySnapshot: [...sampleSnapshots.itinerarySnapshot],
            primaryContact: { name: 'S Lead', email: 's@example.com', phone: '+919988776655' },
          },
          client,
        );

        throw new Error('SIMULATED_FAIL');
      });
    } catch {
      // Expected
    }

    const checkBooking = await bookingRepo.findByReference(ref);
    expect(checkBooking).toBeNull();
  });

  // ============================================================
  // TEST T — SQL injection attempts produce safe responses
  // ============================================================
  it('TEST T — SQL injection in booking reference returns canonical 404 without SQL error', async () => {
    if (!isDbAvailable) return;

    const injection = "BK-INJECT'; DROP TABLE bookings; --";
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${encodeURIComponent(injection)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(response.statusCode).toBe(404);
    const json = JSON.parse(response.payload);
    expect(json.error.code).toBe(ErrorCodes.BOOKING_NOT_FOUND);
  });

  // ============================================================
  // TEST U — Client totalPrice tampering rejected
  // ============================================================
  it('TEST U — Client sending client-controlled totalPrice is rejected with 400 VALIDATION_ERROR', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': crypto.randomUUID() },
      payload: {
        departureId: departure.id,
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        totalPrice: 1, // Tampered price
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Tamper',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
        primaryContact: { name: 'Tamper', email: 't@example.com', phone: '+919988776655' },
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  // ============================================================
  // TEST V — Client customerId tampering rejected
  // ============================================================
  it('TEST V — Client sending customerId in body is rejected with 400 VALIDATION_ERROR', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': crypto.randomUUID() },
      payload: {
        departureId: departure.id,
        customerId: customerIdB, // Tampered customer ID
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Tamper Cust',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
        primaryContact: { name: 'Tamper Cust', email: 't@example.com', phone: '+919988776655' },
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  // ============================================================
  // TEST W — Client status tampering rejected
  // ============================================================
  it('TEST W — Client sending status in body is rejected with 400 VALIDATION_ERROR', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': crypto.randomUUID() },
      payload: {
        departureId: departure.id,
        status: 'CONFIRMED', // Tampered status
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Tamper Status',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
        primaryContact: { name: 'Tamper Status', email: 't@example.com', phone: '+919988776655' },
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  // ============================================================
  // TEST X — Client holdId tampering rejected
  // ============================================================
  it('TEST X — Client sending holdId in body is rejected with 400 VALIDATION_ERROR', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': crypto.randomUUID() },
      payload: {
        departureId: departure.id,
        holdId: crypto.randomUUID(), // Tampered hold ID
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Tamper Hold',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
        primaryContact: { name: 'Tamper Hold', email: 't@example.com', phone: '+919988776655' },
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  // ============================================================
  // TEST Y — Expired holds are removed from availability calculation
  // ============================================================
  it('TEST Y — Expired holds are excluded from availability calculation (capacity restored)', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    // Create an expired hold
    await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-y-${Date.now()}`,
      userId: customerIdA,
      heldSeats: 4,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 10000), // Expired
    });

    const avail = await availabilityService.getDepartureAvailability(departure.id);
    expect(avail.availableSeats).toBe(10); // Expired hold does NOT consume seats
  });

  // ============================================================
  // TEST Z — Confirmed bookings reduce available inventory through booked_seats
  // ============================================================
  it('TEST Z — Confirmed bookings reduce available inventory through booked_seats', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    await db.query(`UPDATE departure_schedules SET booked_seats = 4 WHERE id = $1;`, [
      departure.id,
    ]);

    const avail = await availabilityService.getDepartureAvailability(departure.id);
    expect(avail.availableSeats).toBe(6); // 10 - 4 = 6
    expect(avail.bookedSeats).toBe(4);
  });
});
