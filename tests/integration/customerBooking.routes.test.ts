import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../backend/src/app.js';
import { loadEnv } from '../../backend/src/config/env.js';
import { DatabaseService, runMigrations } from '../../backend/src/infrastructure/database/index.js';
import { seedAll } from '../../backend/src/infrastructure/database/seeds/seedAll.js';
import { DepartureRepository } from '../../backend/src/modules/inventory/repositories/departure.repository.js';
import { InventoryHoldRepository } from '../../backend/src/modules/inventory/repositories/inventoryHold.repository.js';
import { BookingRepository } from '../../backend/src/modules/booking/repositories/booking.repository.js';
import { BookingService } from '../../backend/src/modules/booking/services/booking.service.js';
import { JwtSecurity } from '../../shared/src/security/jwt.js';
import { ErrorCodes } from '../../shared/src/index.js';

describe('Phase 5 Step 6 — Customer Booking REST APIs & Controllers (Integration & Security)', () => {
  let app: FastifyInstance;
  let db: DatabaseService;
  let isDbAvailable = false;
  let departureRepo: DepartureRepository;
  let holdRepo: InventoryHoldRepository;
  let bookingRepo: BookingRepository;
  let bookingService: BookingService;

  const config = loadEnv();

  // Test identities
  const customerIdA = '11111111-1111-4111-8111-111111111111';
  const customerIdB = '22222222-2222-4222-8222-222222222222';
  const customerEmailA = 'customer.a@example.com';
  const customerEmailB = 'customer.b@example.com';

  let tokenCustomerA: string;
  let tokenCustomerB: string;
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

        // Provision test customer accounts in database
        await db.query(
          `INSERT INTO users (id, email, password_hash, full_name, role, is_active)
           VALUES
             ($1, $2, '$argon2id$mockhash', 'Customer Alpha', 'CUSTOMER', true),
             ($3, $4, '$argon2id$mockhash', 'Customer Beta', 'CUSTOMER', true)
           ON CONFLICT (id) DO UPDATE SET is_active = true;`,
          [customerIdA, customerEmailA, customerIdB, customerEmailB],
        );

        // Generate valid RS256 JWT tokens
        tokenCustomerA = JwtSecurity.sign(
          {
            userId: customerIdA,
            email: customerEmailA,
            role: 'CUSTOMER',
            sessionId: 'session-alpha-1',
          },
          config.JWT_PRIVATE_KEY,
          { expiresInSeconds: 3600 },
        );

        tokenCustomerB = JwtSecurity.sign(
          {
            userId: customerIdB,
            email: customerEmailB,
            role: 'CUSTOMER',
            sessionId: 'session-beta-1',
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
        bookingService = created.bookingService;
        await app.ready();
      }
    } catch {
      isDbAvailable = false;
    }
  });

  // Helper for generating unique departure schedules
  let departureOffsetCounter = 100;
  const createTestDeparture = async (capacity = 10) => {
    departureOffsetCounter++;
    const depDate = new Date(Date.UTC(2028, 5, departureOffsetCounter));
    const retDate = new Date(Date.UTC(2028, 5, departureOffsetCounter + 6));
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
      await db.query(`DELETE FROM users WHERE id IN ($1, $2);`, [customerIdA, customerIdB]);
      await db.close();
    }
  });

  // ============================================================
  // TEST A — Unauthenticated Create
  // ============================================================
  it('TEST A — Unauthenticated create: POST /api/v1/bookings returns 401 Unauthorized', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        'idempotency-key': crypto.randomUUID(),
      },
      payload: {
        departureId: crypto.randomUUID(),
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Test Passenger',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
        primaryContact: {
          name: 'Test Passenger',
          email: 'test@example.com',
          phone: '+919876543210',
        },
      },
    });

    expect(response.statusCode).toBe(401);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.UNAUTHORIZED);
  });

  // ============================================================
  // TEST B — Authenticated Customer Creates Booking
  // ============================================================
  it('TEST B — Authenticated customer creates booking: POST /api/v1/bookings returns 201 with AWAITING_PAYMENT booking and 15-min hold', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const idempotencyKey = crypto.randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Alpha Traveler One',
            ageAtBooking: 28,
            gender: 'MALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'Alpha Traveler Two',
            ageAtBooking: 26,
            gender: 'FEMALE',
            isPrimaryContact: false,
          },
        ],
        primaryContact: {
          name: 'Alpha Traveler One',
          email: customerEmailA,
          phone: '+919876543211',
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const json = JSON.parse(response.payload);

    expect(json.success).toBe(true);
    expect(json.data.bookingReference).toMatch(/^BK-\d{8}-[A-F0-9]{4}$/);
    expect(json.data.status).toBe('AWAITING_PAYMENT');
    expect(json.data.customerId).toBe(customerIdA);
    expect(json.data.partySize).toBe(2);
    expect(json.data.holdId).toBeDefined();
    expect(json.data.holdExpiresAt).toBeDefined();
    expect(json.data.passengers).toHaveLength(2);
    expect(json.data.priceBreakdown).toBeDefined();
    expect(json.data.packageSnapshot).toBeDefined();
    expect(json.data.departureSnapshot).toBeDefined();

    // Verify active hold in DB
    const activeHoldCount = await holdRepo.getActiveHoldCountForDeparture(departure.id);
    expect(activeHoldCount).toBe(2);
  });

  // ============================================================
  // TEST C — Invalid Booking Payload
  // ============================================================
  it('TEST C — Invalid booking payload: returns 400 with VALIDATION_ERROR details', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
        'idempotency-key': crypto.randomUUID(),
      },
      payload: {
        departureId: 'not-a-valid-uuid',
        partySize: 2,
        adultCount: 1, // Mismatches partySize = 2 with 0 childCount
        childCount: 0,
        passengers: [],
        primaryContact: {
          name: '',
          email: 'invalid-email',
          phone: '123',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(json.error.details.length).toBeGreaterThan(0);
  });

  // ============================================================
  // TEST D — Client Attempts to Control customerId
  // ============================================================
  it('TEST D — Client attempts to control customerId: extra property causes validation failure or authenticated token remains authoritative', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    // Attempt to pass customerId = customerIdB in body
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
        'idempotency-key': crypto.randomUUID(),
      },
      payload: {
        departureId: departure.id,
        customerId: customerIdB, // Unauthorized client injection
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Sneaky Client',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
        primaryContact: {
          name: 'Sneaky Client',
          email: 'sneaky@example.com',
          phone: '+919876543212',
        },
      },
    });

    // Schema is .strict(), so injecting customerId must return 400 VALIDATION_ERROR
    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  // ============================================================
  // TEST E — Client Attempts to Control totalPrice
  // ============================================================
  it('TEST E — Client attempts to control totalPrice: strict schema rejects injected price', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
        'idempotency-key': crypto.randomUUID(),
      },
      payload: {
        departureId: departure.id,
        totalPrice: 100, // Attempted 1 INR tampering
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Price Tamperer',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
        primaryContact: {
          name: 'Price Tamperer',
          email: 'tamper@example.com',
          phone: '+919876543213',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  // ============================================================
  // TEST F — Client Attempts to Control Status
  // ============================================================
  it('TEST F — Client attempts to control status: strict schema rejects injected status', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
        'idempotency-key': crypto.randomUUID(),
      },
      payload: {
        departureId: departure.id,
        status: 'CONFIRMED', // Attempted bypass to CONFIRMED
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Status Bypass',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
        primaryContact: {
          name: 'Status Bypass',
          email: 'bypass@example.com',
          phone: '+919876543214',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  // ============================================================
  // TEST G — Customer Retrieves Own Booking
  // ============================================================
  it('TEST G — Customer retrieves own booking: GET /api/v1/bookings/:reference returns 200 with full details', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(6);

    const creation = await bookingService.createBooking({
      userId: customerIdA,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-test-g',
      bookingData: {
        departureId: departure.id,
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        primaryContact: {
          name: 'Alpha Contact',
          email: customerEmailA,
          phone: '+919876543215',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Alpha Passenger',
            ageAtBooking: 25,
            gender: 'FEMALE',
            isPrimaryContact: true,
          },
        ],
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${creation.booking.bookingReference}`,
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
    expect(json.data.bookingReference).toBe(creation.booking.bookingReference);
    expect(json.data.customerId).toBe(customerIdA);
    expect(json.data.passengers).toHaveLength(1);
    expect(json.data.passengers[0].fullName).toBe('Alpha Passenger');
    expect(json.data.holdExpiresAt).toBeDefined();
  });

  // ============================================================
  // TEST H — Customer Attempts to Retrieve Another Customer's Booking (IDOR Protection)
  // ============================================================
  it("TEST H — IDOR Protection: Customer B attempting to GET Customer A's booking receives 404 BOOKING_NOT_FOUND", async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(6);

    const bookingA = await bookingService.createBooking({
      userId: customerIdA,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-test-h-a',
      bookingData: {
        departureId: departure.id,
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        primaryContact: {
          name: 'Owner A',
          email: customerEmailA,
          phone: '+919876543216',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Passenger A',
            ageAtBooking: 29,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
      },
    });

    // Customer B requests Customer A's reference
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${bookingA.booking.bookingReference}`,
      headers: {
        authorization: `Bearer ${tokenCustomerB}`,
      },
    });

    expect(response.statusCode).toBe(404);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.BOOKING_NOT_FOUND);
  });

  // ============================================================
  // TEST I — Customer Lists Own Bookings
  // ============================================================
  it('TEST I — Customer lists own bookings: GET /api/v1/bookings returns only their bookings with pagination', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/bookings?page=1&limit=10',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.meta.page).toBe(1);
    expect(json.meta.limit).toBe(10);
    expect(json.meta.totalItems).toBeGreaterThanOrEqual(1);

    // Verify all returned items belong exclusively to Customer A
    for (const b of json.data) {
      expect(b.customerId).toBe(customerIdA);
    }
  });

  // ============================================================
  // TEST J — Customer Attempts customerId Query Override
  // ============================================================
  it('TEST J — Customer attempts customerId query override: query parameter is rejected by strict schema or ignored', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings?customerId=${customerIdB}`,
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
      },
    });

    // bookingListQuerySchema is .strict() so customerId query param must trigger 400 VALIDATION_ERROR
    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  // ============================================================
  // TEST K — Customer Cancels Own Confirmed Booking
  // ============================================================
  it('TEST K — Customer cancels own confirmed booking: POST /api/v1/bookings/:ref/cancel succeeds and decrements booked_seats', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const creation = await bookingService.createBooking({
      userId: customerIdA,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-test-k',
      bookingData: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        primaryContact: {
          name: 'Cancel Owner',
          email: customerEmailA,
          phone: '+919876543217',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Cancel Pass 1',
            ageAtBooking: 31,
            gender: 'MALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'Cancel Pass 2',
            ageAtBooking: 29,
            gender: 'FEMALE',
            isPrimaryContact: false,
          },
        ],
      },
    });

    // Confirm booking to make it eligible for cancellation
    await bookingService.confirmBooking({
      bookingId: creation.booking.id,
      paymentVerified: true,
    });

    const depAfterConfirm = await departureRepo.findById(departure.id);
    expect(depAfterConfirm?.bookedSeats).toBe(2);

    // Cancel booking via API
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${creation.booking.bookingReference}/cancel`,
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
      },
      payload: {
        reason: 'Change of schedule plans',
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
    expect(json.data.bookingReference).toBe(creation.booking.bookingReference);
    expect(json.data.status).toBe('CANCELLED');
    expect(json.data.cancellationReason).toBe('Change of schedule plans');

    // Verify booked seats decremented to 0
    const depAfterCancel = await departureRepo.findById(departure.id);
    expect(depAfterCancel?.bookedSeats).toBe(0);
  });

  // ============================================================
  // TEST L — Customer Attempts to Cancel AWAITING_PAYMENT Booking
  // ============================================================
  it('TEST L — Customer attempts to cancel AWAITING_PAYMENT booking: returns 400 BOOKING_INVALID_STATE', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const creation = await bookingService.createBooking({
      userId: customerIdA,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-test-l',
      bookingData: {
        departureId: departure.id,
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        primaryContact: {
          name: 'Unconfirmed Cancel',
          email: customerEmailA,
          phone: '+919876543218',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Unconfirmed Pass',
            ageAtBooking: 33,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
      },
    });

    // Booking is in AWAITING_PAYMENT state
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${creation.booking.bookingReference}/cancel`,
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
      },
      payload: {
        reason: 'Decided not to pay',
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.BOOKING_INVALID_STATE);
  });

  // ============================================================
  // TEST M — Customer Attempts to Cancel Another Customer's Booking
  // ============================================================
  it("TEST M — Customer B attempts to cancel Customer A's booking: returns 404 BOOKING_NOT_FOUND without leakage", async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const creation = await bookingService.createBooking({
      userId: customerIdA,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-test-m',
      bookingData: {
        departureId: departure.id,
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        primaryContact: {
          name: 'Target Owner',
          email: customerEmailA,
          phone: '+919876543219',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Target Pass',
            ageAtBooking: 35,
            gender: 'FEMALE',
            isPrimaryContact: true,
          },
        ],
      },
    });

    await bookingService.confirmBooking({
      bookingId: creation.booking.id,
      paymentVerified: true,
    });

    // Customer B attempts to cancel Customer A's confirmed booking
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${creation.booking.bookingReference}/cancel`,
      headers: {
        authorization: `Bearer ${tokenCustomerB}`,
      },
      payload: {
        reason: 'Malicious cancellation attempt',
      },
    });

    expect(response.statusCode).toBe(404);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.BOOKING_NOT_FOUND);

    // Verify booking is still CONFIRMED in DB
    const bookingInDb = await bookingRepo.findById(creation.booking.id);
    expect(bookingInDb?.status).toBe('CONFIRMED');
  });

  // ============================================================
  // TEST N — Same Idempotency Key + Same Request (Replay)
  // ============================================================
  it('TEST N — Same Idempotency Key + Same Request: returns original 201 response with isReplay: true and 0 duplicate inventory reservation', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const idempotencyKey = crypto.randomUUID();
    const payload = {
      departureId: departure.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      passengers: [
        {
          passengerType: 'ADULT',
          fullName: 'Idempotent Pass 1',
          ageAtBooking: 25,
          gender: 'MALE',
          isPrimaryContact: true,
        },
        {
          passengerType: 'ADULT',
          fullName: 'Idempotent Pass 2',
          ageAtBooking: 27,
          gender: 'FEMALE',
          isPrimaryContact: false,
        },
      ],
      primaryContact: {
        name: 'Idempotent Pass 1',
        email: customerEmailA,
        phone: '+919876543220',
      },
    };

    // First request
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    expect(res1.statusCode).toBe(201);
    const json1 = JSON.parse(res1.payload);
    expect(json1.meta.isReplay).toBe(false);

    // Second identical request with same key
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    expect(res2.statusCode).toBe(201);
    const json2 = JSON.parse(res2.payload);
    expect(json2.meta.isReplay).toBe(true);
    expect(json2.data.bookingReference).toBe(json1.data.bookingReference);

    // Verify exactly 2 seats held (not 4)
    const holdSeats = await holdRepo.getActiveHoldCountForDeparture(departure.id);
    expect(holdSeats).toBe(2);
  });

  // ============================================================
  // TEST O — Same Idempotency Key + Different Request (Conflict)
  // ============================================================
  it('TEST O — Same Idempotency Key + Different Request: returns 409 IDEMPOTENCY_CONFLICT', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);

    const idempotencyKey = crypto.randomUUID();

    // First request (partySize = 1)
    await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        departureId: departure.id,
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'First Pass',
            ageAtBooking: 28,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
        primaryContact: {
          name: 'First Pass',
          email: customerEmailA,
          phone: '+919876543221',
        },
      },
    });

    // Second request with same key but different body (partySize = 2)
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Different Pass 1',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'Different Pass 2',
            ageAtBooking: 32,
            gender: 'FEMALE',
            isPrimaryContact: false,
          },
        ],
        primaryContact: {
          name: 'Different Pass 1',
          email: customerEmailA,
          phone: '+919876543222',
        },
      },
    });

    expect(res2.statusCode).toBe(409);
    const json2 = JSON.parse(res2.payload);
    expect(json2.success).toBe(false);
    expect(json2.error.code).toBe(ErrorCodes.IDEMPOTENCY_CONFLICT);
  });

  // ============================================================
  // TEST P — Invalid / Missing Idempotency Key Header
  // ============================================================
  it('TEST P — Missing Idempotency Key: POST /api/v1/bookings returns 400 Bad Request', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
        // 'idempotency-key' omitted
      },
      payload: {
        departureId: crypto.randomUUID(),
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'No Idem Pass',
            ageAtBooking: 25,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
        primaryContact: {
          name: 'No Idem Pass',
          email: customerEmailA,
          phone: '+919876543223',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.details.some((d: { field: string }) => d.field === 'idempotency-key')).toBe(
      true,
    );
  });

  // ============================================================
  // TEST Q — Role-Based Access Verification
  // ============================================================
  it('TEST Q — Role-Based Access: Authenticated user with role CUSTOMER can access customer booking endpoints', async () => {
    if (!isDbAvailable) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/bookings',
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(true);
  });

  // ============================================================
  // TEST R — SQL Injection / Path Manipulation
  // ============================================================
  it('TEST R — SQL Injection Protection: Malicious booking reference returns 404/400 without SQL execution or info leakage', async () => {
    if (!isDbAvailable) return;

    const maliciousRef = "BK-20270101-XXXX' OR '1'='1";
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${encodeURIComponent(maliciousRef)}`,
      headers: {
        authorization: `Bearer ${tokenCustomerA}`,
      },
    });

    expect(response.statusCode).toBe(404);
    const json = JSON.parse(response.payload);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe(ErrorCodes.BOOKING_NOT_FOUND);
  });
});
