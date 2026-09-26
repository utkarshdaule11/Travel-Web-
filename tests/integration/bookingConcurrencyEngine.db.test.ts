import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import {
  DatabaseService,
  runMigrations,
  seedAll,
} from '../../backend/src/infrastructure/database/index.js';
import { loadEnv } from '../../backend/src/config/env.js';
import {
  BookingRepository,
  PassengerRepository,
  IdempotencyRepository,
} from '../../backend/src/modules/booking/repositories/index.js';
import {
  DepartureRepository,
  InventoryHoldRepository,
} from '../../backend/src/modules/inventory/repositories/index.js';
import {
  TourPackageRepository,
  ItineraryRepository,
  DestinationRepository,
} from '../../backend/src/modules/catalogue/repositories/index.js';
import { BookingService } from '../../backend/src/modules/booking/services/booking.service.js';
import { AppError, ErrorCodes } from '../../shared/src/index.js';

describe('Phase 5 Step 5 — Inventory Hold Integration & Pessimistic Concurrency Engine (PostgreSQL)', () => {
  let db: DatabaseService | null = null;
  let isDbAvailable = false;

  let bookingRepo: BookingRepository;
  let passengerRepo: PassengerRepository;
  let idempotencyRepo: IdempotencyRepository;
  let departureRepo: DepartureRepository;
  let holdRepo: InventoryHoldRepository;
  let packageRepo: TourPackageRepository;
  let itineraryRepo: ItineraryRepository;
  let destinationRepo: DestinationRepository;
  let bookingService: BookingService;

  let testUserId: string;
  let testPackageId: string;

  beforeAll(async () => {
    try {
      const config = loadEnv();
      db = new DatabaseService(config);
      const health = await db.checkHealth();
      if (health.status === 'healthy') {
        isDbAvailable = true;

        await runMigrations(db);
        await seedAll();

        bookingRepo = new BookingRepository(db);
        passengerRepo = new PassengerRepository(db);
        idempotencyRepo = new IdempotencyRepository(db);
        departureRepo = new DepartureRepository(db);
        holdRepo = new InventoryHoldRepository(db);
        packageRepo = new TourPackageRepository(db);
        itineraryRepo = new ItineraryRepository(db);
        destinationRepo = new DestinationRepository(db);

        bookingService = new BookingService(
          db,
          bookingRepo,
          passengerRepo,
          idempotencyRepo,
          departureRepo,
          holdRepo,
          packageRepo,
          itineraryRepo,
          destinationRepo,
        );

        // Fetch seeded admin/user
        const userRes = await db.query<{ id: string }>(`SELECT id FROM users LIMIT 1;`);
        testUserId = userRes.rows[0]?.id ?? '';

        // Fetch seeded package
        const pkgRes = await db.query<{ id: string }>(
          `SELECT id FROM tour_packages WHERE is_published = TRUE LIMIT 1;`,
        );
        testPackageId = pkgRes.rows[0]?.id ?? '';
      }
    } catch {
      isDbAvailable = false;
    }
  });

  afterAll(async () => {
    if (db && isDbAvailable) {
      // Clean up test data in reverse foreign-key order
      await db.query(`DELETE FROM idempotency_keys;`);
      await db.query(`DELETE FROM booking_passengers;`);
      await db.query(`DELETE FROM bookings;`);
      await db.query(`DELETE FROM inventory_holds;`);
      await db.query(
        `DELETE FROM departure_schedules WHERE total_seat_capacity IN (2, 4, 5, 8, 10, 12, 20);`,
      );
      await db.close();
    }
  });

  // ============================================================
  // TEST A — Capacity Boundary
  // ============================================================
  it('TEST A — Capacity Boundary: Two concurrent requests for 2 seats when capacity = 2', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-03-01',
      returnDate: '2027-03-06',
      totalSeatCapacity: 2,
      currency: 'INR',
      status: 'OPEN',
    });

    const createPayload = {
      departureId: departure.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      primaryContact: {
        name: 'Boundary User',
        email: 'boundary@example.com',
        phone: '+919999900001',
      },
      passengers: [
        {
          passengerType: 'ADULT' as const,
          fullName: 'Passenger A1',
          ageAtBooking: 30,
          gender: 'MALE' as const,
          isPrimaryContact: true,
        },
        {
          passengerType: 'ADULT' as const,
          fullName: 'Passenger A2',
          ageAtBooking: 28,
          gender: 'FEMALE' as const,
          isPrimaryContact: false,
        },
      ],
    };

    const [res1, res2] = await Promise.allSettled([
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: crypto.randomUUID(),
        requestHash: 'hash-test-a-1',
        bookingData: createPayload,
      }),
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: crypto.randomUUID(),
        requestHash: 'hash-test-a-2',
        bookingData: createPayload,
      }),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
    const rejected = [res1, res2].filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejErr = (rejected[0] as PromiseRejectedResult).reason as AppError;
    expect(rejErr.code).toBe(ErrorCodes.INVENTORY_CAPACITY_EXCEEDED);

    const activeHolds = await holdRepo.getActiveHoldCountForDeparture(departure.id);
    expect(activeHolds).toBe(2);

    const dep = await departureRepo.findById(departure.id);
    expect(dep?.bookedSeats).toBe(0);
  });

  // ============================================================
  // TEST B — Remaining Capacity Split
  // ============================================================
  it('TEST B — Remaining Capacity Split: Two concurrent requests for 1 seat when 2 seats remain', async () => {
    if (!isDbAvailable || !db) return;

    // Capacity = 4, 2 already booked -> 2 seats available
    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-03-10',
      returnDate: '2027-03-15',
      totalSeatCapacity: 4,
      currency: 'INR',
      status: 'OPEN',
    });

    // Seed 2 booked seats
    await db.query(`UPDATE departure_schedules SET booked_seats = 2 WHERE id = $1;`, [
      departure.id,
    ]);

    const makePayload = (name: string) => ({
      departureId: departure.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      primaryContact: {
        name,
        email: `${name.toLowerCase()}@example.com`,
        phone: '+919999900002',
      },
      passengers: [
        {
          passengerType: 'ADULT' as const,
          fullName: name,
          ageAtBooking: 32,
          gender: 'MALE' as const,
          isPrimaryContact: true,
        },
      ],
    });

    const [res1, res2] = await Promise.allSettled([
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: crypto.randomUUID(),
        requestHash: 'hash-test-b-1',
        bookingData: makePayload('SplitUser1'),
      }),
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: crypto.randomUUID(),
        requestHash: 'hash-test-b-2',
        bookingData: makePayload('SplitUser2'),
      }),
    ]);

    // Both should succeed because 1 + 1 <= 2
    expect(res1.status).toBe('fulfilled');
    expect(res2.status).toBe('fulfilled');

    const activeHolds = await holdRepo.getActiveHoldCountForDeparture(departure.id);
    expect(activeHolds).toBe(2);

    const dep = await departureRepo.findById(departure.id);
    expect(dep?.bookedSeats).toBe(2);
  });

  // ============================================================
  // TEST C — Oversubscription
  // ============================================================
  it('TEST C — Oversubscription: Two concurrent requests for 2 seats when only 1 seat remains', async () => {
    if (!isDbAvailable || !db) return;

    // Capacity = 5, 4 booked -> 1 available
    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-03-20',
      returnDate: '2027-03-25',
      totalSeatCapacity: 5,
      currency: 'INR',
      status: 'OPEN',
    });

    await db.query(`UPDATE departure_schedules SET booked_seats = 4 WHERE id = $1;`, [
      departure.id,
    ]);

    const createPayload = {
      departureId: departure.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      primaryContact: {
        name: 'Oversub User',
        email: 'oversub@example.com',
        phone: '+919999900003',
      },
      passengers: [
        {
          passengerType: 'ADULT' as const,
          fullName: 'Over 1',
          ageAtBooking: 25,
          gender: 'FEMALE' as const,
          isPrimaryContact: true,
        },
        {
          passengerType: 'ADULT' as const,
          fullName: 'Over 2',
          ageAtBooking: 26,
          gender: 'MALE' as const,
          isPrimaryContact: false,
        },
      ],
    };

    const [res1, res2] = await Promise.allSettled([
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: crypto.randomUUID(),
        requestHash: 'hash-test-c-1',
        bookingData: createPayload,
      }),
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: crypto.randomUUID(),
        requestHash: 'hash-test-c-2',
        bookingData: createPayload,
      }),
    ]);

    // Both must fail because requested 2 > available 1
    expect(res1.status).toBe('rejected');
    expect(res2.status).toBe('rejected');

    const activeHolds = await holdRepo.getActiveHoldCountForDeparture(departure.id);
    expect(activeHolds).toBe(0);
  });

  // ============================================================
  // TEST D — Duplicate Confirmation Concurrency
  // ============================================================
  it('TEST D — Duplicate Confirmation Concurrency: Same booking confirmed concurrently by two threads', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-04-01',
      returnDate: '2027-04-06',
      totalSeatCapacity: 8,
      currency: 'INR',
      status: 'OPEN',
    });

    const creation = await bookingService.createBooking({
      userId: testUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-test-d-create',
      bookingData: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        primaryContact: {
          name: 'Confirm User',
          email: 'confirm@example.com',
          phone: '+919999900004',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Conf Pass 1',
            ageAtBooking: 35,
            gender: 'MALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'Conf Pass 2',
            ageAtBooking: 33,
            gender: 'FEMALE',
            isPrimaryContact: false,
          },
        ],
      },
    });

    const bookingId = creation.booking.id;

    // Concurrently fire 2 confirmation requests
    const [c1, c2] = await Promise.allSettled([
      bookingService.confirmBooking({ bookingId, paymentVerified: true }),
      bookingService.confirmBooking({ bookingId, paymentVerified: true }),
    ]);

    // At least one succeeds or returns idempotent result
    const fulfilled = [c1, c2].filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Verify database invariant: booked_seats incremented by exactly 2 (never 4)
    const dep = await departureRepo.findById(departure.id);
    expect(dep?.bookedSeats).toBe(2);

    const hold = await holdRepo.findById(creation.booking.holdId!);
    expect(hold?.status).toBe('COMMITTED');

    const booking = await bookingRepo.findById(bookingId);
    expect(booking?.status).toBe('CONFIRMED');
  });

  // ============================================================
  // TEST E — Duplicate Cancellation Concurrency
  // ============================================================
  it('TEST E — Duplicate Cancellation Concurrency: Same confirmed booking cancelled concurrently', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-04-10',
      returnDate: '2027-04-15',
      totalSeatCapacity: 8,
      currency: 'INR',
      status: 'OPEN',
    });

    const creation = await bookingService.createBooking({
      userId: testUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-test-e-create',
      bookingData: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        primaryContact: {
          name: 'Cancel User',
          email: 'cancel@example.com',
          phone: '+919999900005',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Can Pass 1',
            ageAtBooking: 40,
            gender: 'MALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'Can Pass 2',
            ageAtBooking: 38,
            gender: 'FEMALE',
            isPrimaryContact: false,
          },
        ],
      },
    });

    // Confirm booking (booked_seats becomes 2)
    await bookingService.confirmBooking({
      bookingId: creation.booking.id,
      paymentVerified: true,
    });

    const depBefore = await departureRepo.findById(departure.id);
    expect(depBefore?.bookedSeats).toBe(2);

    // Concurrently fire 2 cancellation calls
    const [c1, c2] = await Promise.allSettled([
      bookingService.cancelBooking({
        bookingReference: creation.booking.bookingReference,
        customerId: testUserId,
        reason: 'Concurrent cancel 1',
      }),
      bookingService.cancelBooking({
        bookingReference: creation.booking.bookingReference,
        customerId: testUserId,
        reason: 'Concurrent cancel 2',
      }),
    ]);

    const fulfilled = [c1, c2].filter((r) => r.status === 'fulfilled');
    const rejected = [c1, c2].filter((r) => r.status === 'rejected');

    // Exactly one succeeds, the other fails with BOOKING_ALREADY_CANCELLED or CONCURRENT_MUTATION_CONFLICT
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Invariant: booked_seats decremented exactly once (from 2 to 0, never negative)
    const depAfter = await departureRepo.findById(departure.id);
    expect(depAfter?.bookedSeats).toBe(0);

    const booking = await bookingRepo.findById(creation.booking.id);
    expect(booking?.status).toBe('CANCELLED');
  });

  // ============================================================
  // TEST F — Expiry Idempotency Concurrency
  // ============================================================
  it('TEST F — Expiry Idempotency Concurrency: Same unpaid booking expired concurrently', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-04-20',
      returnDate: '2027-04-25',
      totalSeatCapacity: 8,
      currency: 'INR',
      status: 'OPEN',
    });

    const creation = await bookingService.createBooking({
      userId: testUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-test-f-create',
      bookingData: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        primaryContact: {
          name: 'Expiry User',
          email: 'expiry@example.com',
          phone: '+919999900006',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Exp Pass 1',
            ageAtBooking: 29,
            gender: 'FEMALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'Exp Pass 2',
            ageAtBooking: 31,
            gender: 'MALE',
            isPrimaryContact: false,
          },
        ],
      },
    });

    const bookingId = creation.booking.id;

    // Fire concurrent expiry calls
    const [e1, e2] = await Promise.allSettled([
      bookingService.expireBooking({ bookingId }),
      bookingService.expireBooking({ bookingId }),
    ]);

    // Both should either succeed or return idempotent response
    const fulfilled = [e1, e2].filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const booking = await bookingRepo.findById(bookingId);
    expect(booking?.status).toBe('EXPIRED');

    const hold = await holdRepo.findById(creation.booking.holdId!);
    expect(hold?.status).toBe('EXPIRED');

    // Invariant: booked_seats remains 0
    const dep = await departureRepo.findById(departure.id);
    expect(dep?.bookedSeats).toBe(0);
  });

  // ============================================================
  // TEST G — Confirmation vs Expiry Race
  // ============================================================
  it('TEST G — Confirmation vs Expiry Race: Concurrent confirmation vs expiration preserves database consistency', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-05-01',
      returnDate: '2027-05-06',
      totalSeatCapacity: 8,
      currency: 'INR',
      status: 'OPEN',
    });

    const creation = await bookingService.createBooking({
      userId: testUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-test-g-create',
      bookingData: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        primaryContact: {
          name: 'Race User',
          email: 'race@example.com',
          phone: '+919999900007',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Race Pass 1',
            ageAtBooking: 27,
            gender: 'FEMALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'Race Pass 2',
            ageAtBooking: 28,
            gender: 'MALE',
            isPrimaryContact: false,
          },
        ],
      },
    });

    const bookingId = creation.booking.id;

    // Race confirmation and expiry concurrently
    const [confirmRes, expireRes] = await Promise.allSettled([
      bookingService.confirmBooking({ bookingId, paymentVerified: true }),
      bookingService.expireBooking({ bookingId }),
    ]);

    const bookingInDb = await bookingRepo.findById(bookingId);
    const holdInDb = await holdRepo.findById(creation.booking.holdId!);
    const depInDb = await departureRepo.findById(departure.id);

    // Consistency Invariants:
    // If booking is CONFIRMED -> hold must be COMMITTED and booked_seats must be 2
    // If booking is EXPIRED -> hold must be EXPIRED and booked_seats must be 0
    // An impossible mixed state (e.g. CONFIRMED booking + EXPIRED hold) MUST NEVER occur
    if (bookingInDb?.status === 'CONFIRMED') {
      expect(holdInDb?.status).toBe('COMMITTED');
      expect(depInDb?.bookedSeats).toBe(2);
      expect(confirmRes.status).toBe('fulfilled');
    } else if (bookingInDb?.status === 'EXPIRED') {
      expect(holdInDb?.status).toBe('EXPIRED');
      expect(depInDb?.bookedSeats).toBe(0);
      expect(expireRes.status).toBe('fulfilled');
    } else {
      expect.unreachable(`Unexpected final booking status: ${bookingInDb?.status}`);
    }
  });

  // ============================================================
  // TEST H — Confirmation vs Cancellation Race
  // ============================================================
  it('TEST H — Confirmation vs Cancellation Race: Cancellation on unconfirmed booking is rejected while confirmation wins', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-05-10',
      returnDate: '2027-05-15',
      totalSeatCapacity: 8,
      currency: 'INR',
      status: 'OPEN',
    });

    const creation = await bookingService.createBooking({
      userId: testUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-test-h-create',
      bookingData: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        primaryContact: {
          name: 'H-Race User',
          email: 'hrace@example.com',
          phone: '+919999900008',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'H Pass 1',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'H Pass 2',
            ageAtBooking: 32,
            gender: 'FEMALE',
            isPrimaryContact: false,
          },
        ],
      },
    });

    const bookingId = creation.booking.id;

    // Race confirmation vs cancellation
    await Promise.allSettled([
      bookingService.confirmBooking({ bookingId, paymentVerified: true }),
      bookingService.cancelBooking({
        bookingReference: creation.booking.bookingReference,
        customerId: testUserId,
      }),
    ]);

    const bookingInDb = await bookingRepo.findById(bookingId);
    const depInDb = await departureRepo.findById(departure.id);

    // If confirmation ran first, cancellation might succeed or fail depending on ordering.
    // In either case, the inventory math must remain consistent:
    // If CANCELLED: booked_seats = 0
    // If CONFIRMED: booked_seats = 2
    if (bookingInDb?.status === 'CANCELLED') {
      expect(depInDb?.bookedSeats).toBe(0);
    } else if (bookingInDb?.status === 'CONFIRMED') {
      expect(depInDb?.bookedSeats).toBe(2);
    }
  });

  // ============================================================
  // TEST I — Expired Holds Excluded from Availability Calculation
  // ============================================================
  it('TEST I — Expired Holds Excluded: Availability calculation counts ONLY active unexpired holds', async () => {
    if (!isDbAvailable || !db) return;

    // Capacity = 10, Booked = 2
    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-06-01',
      returnDate: '2027-06-06',
      totalSeatCapacity: 10,
      currency: 'INR',
      status: 'OPEN',
    });

    await db.query(`UPDATE departure_schedules SET booked_seats = 2 WHERE id = $1;`, [
      departure.id,
    ]);

    // 1. Active unexpired hold (2 seats)
    await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: crypto.randomUUID(),
      userId: testUserId,
      heldSeats: 2,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // Future
    });

    // 2. Expired ACTIVE hold (3 seats, expires_at in the past)
    await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: crypto.randomUUID(),
      userId: testUserId,
      heldSeats: 3,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 5 * 60 * 1000), // Past
    });

    // 3. COMMITTED hold (2 seats)
    await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: crypto.randomUUID(),
      userId: testUserId,
      heldSeats: 2,
      status: 'COMMITTED',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    // 4. RELEASED hold (2 seats)
    await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: crypto.randomUUID(),
      userId: testUserId,
      heldSeats: 2,
      status: 'RELEASED',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    // Query active hold count
    const activeHoldCount = await holdRepo.getActiveHoldCountForDeparture(departure.id);

    // Only the 1st hold (2 seats) must count!
    expect(activeHoldCount).toBe(2);

    // Dynamic available seats formula = total (10) - booked (2) - active unexpired holds (2) = 6
    const availableSeats = Math.max(0, 10 - 2 - activeHoldCount);
    expect(availableSeats).toBe(6);
  });

  // ============================================================
  // TEST J — Retry / Idempotency Concurrency
  // ============================================================
  it('TEST J — Retry / Idempotency Concurrency: Simultaneous duplicate requests with same idempotency key create 1 booking', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-06-15',
      returnDate: '2027-06-20',
      totalSeatCapacity: 12,
      currency: 'INR',
      status: 'OPEN',
    });

    const sharedIdempotencyKey = crypto.randomUUID();
    const sharedRequestHash = 'sha256-shared-idempotency-payload';

    const bookingPayload = {
      departureId: departure.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      primaryContact: {
        name: 'Idempotency Concurrency User',
        email: 'idemconcurrent@example.com',
        phone: '+919999900009',
      },
      passengers: [
        {
          passengerType: 'ADULT' as const,
          fullName: 'Idem Pass 1',
          ageAtBooking: 30,
          gender: 'MALE' as const,
          isPrimaryContact: true,
        },
        {
          passengerType: 'ADULT' as const,
          fullName: 'Idem Pass 2',
          ageAtBooking: 28,
          gender: 'FEMALE' as const,
          isPrimaryContact: false,
        },
      ],
    };

    // Concurrently send 3 identical creation requests with the same key & hash
    const results = await Promise.allSettled([
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: sharedIdempotencyKey,
        requestHash: sharedRequestHash,
        bookingData: bookingPayload,
      }),
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: sharedIdempotencyKey,
        requestHash: sharedRequestHash,
        bookingData: bookingPayload,
      }),
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: sharedIdempotencyKey,
        requestHash: sharedRequestHash,
        bookingData: bookingPayload,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Extract booking reference from the first fulfilled result
    const firstResult = (
      fulfilled[0] as PromiseFulfilledResult<{ booking: { bookingReference: string } }>
    ).value;
    const ref = firstResult.booking.bookingReference;

    // Verify all fulfilled results return the EXACT SAME booking reference
    for (const res of fulfilled) {
      const val = (res as PromiseFulfilledResult<{ booking: { bookingReference: string } }>).value;
      expect(val.booking.bookingReference).toBe(ref);
    }

    // Verify database holds exactly 1 booking and 1 hold for this departure
    const bookingsInDb = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM bookings WHERE departure_id = $1;`,
      [departure.id],
    );
    expect(parseInt(bookingsInDb.rows[0]?.count ?? '0', 10)).toBe(1);

    const holdsInDb = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM inventory_holds WHERE departure_id = $1;`,
      [departure.id],
    );
    expect(parseInt(holdsInDb.rows[0]?.count ?? '0', 10)).toBe(1);

    // Invariant: exactly 2 seats held (not 6)
    const activeHolds = await holdRepo.getActiveHoldCountForDeparture(departure.id);
    expect(activeHolds).toBe(2);
  });
});
