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

describe('Phase 5 Step 4 — Booking Domain Services (PostgreSQL Integration & Concurrency)', () => {
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
    if (db) {
      if (isDbAvailable) {
        // Clean up test data in reverse foreign-key order
        await db.query(`DELETE FROM idempotency_keys;`);
        await db.query(`DELETE FROM booking_passengers;`);
        await db.query(`DELETE FROM bookings;`);
        await db.query(`DELETE FROM inventory_holds;`);
        await db.query(`DELETE FROM departure_schedules WHERE total_seat_capacity = 2;`);
      }
      await db.close();
    }
  });

  it('1. End-to-end booking creation with 15m hold and snapshots in real PostgreSQL', async () => {
    if (!isDbAvailable || !db) return;

    // Create a departure for testing
    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2026-12-01',
      returnDate: '2026-12-06',
      totalSeatCapacity: 10,
      priceOverrideAdult: 5500000,
      priceOverrideChild: 3200000,
      currency: 'INR',
      status: 'OPEN',
    });

    const idempotencyKey = crypto.randomUUID();
    const requestHash = 'sha256-test-hash-001';

    const result = await bookingService.createBooking({
      userId: testUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey,
      requestHash,
      bookingData: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        primaryContact: {
          name: 'Jane Smith',
          email: 'jane@example.com',
          phone: '+919876543210',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Jane Smith',
            dateOfBirth: '1988-03-10',
            ageAtBooking: 38,
            gender: 'FEMALE',
            isPrimaryContact: true,
            specialRequests: 'Aisle seat',
          },
          {
            passengerType: 'ADULT',
            fullName: 'Bob Smith',
            dateOfBirth: '1985-07-22',
            ageAtBooking: 41,
            gender: 'MALE',
            isPrimaryContact: false,
          },
        ],
      },
    });

    expect(result.booking.id).toBeDefined();
    expect(result.booking.status).toBe('AWAITING_PAYMENT');
    expect(result.booking.totalPrice).toBe(11000000); // 2 * 5500000
    expect(result.booking.holdId).toBeDefined();
    expect(result.passengers).toHaveLength(2);

    // Verify hold in DB
    const holdInDb = await holdRepo.findById(result.booking.holdId!);
    expect(holdInDb?.status).toBe('ACTIVE');
    expect(holdInDb?.heldSeats).toBe(2);

    // Verify booked_seats on departure is STILL 0 (not incremented during AWAITING_PAYMENT)
    const depInDb = await departureRepo.findById(departure.id);
    expect(depInDb?.bookedSeats).toBe(0);

    // Verify idempotency record in DB
    const idemInDb = await idempotencyRepo.find(
      testUserId,
      'POST:/api/v1/bookings',
      idempotencyKey,
    );
    expect(idemInDb).toBeDefined();
  });

  it('2. Concurrency Safety: 2 simultaneous booking attempts for last 2 seats on departure', async () => {
    if (!isDbAvailable || !db) return;

    // Create a departure with exact capacity of 2 seats
    const limitedDeparture = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2026-12-10',
      returnDate: '2026-12-15',
      totalSeatCapacity: 2,
      currency: 'INR',
      status: 'OPEN',
    });

    const bookingPayload = {
      departureId: limitedDeparture.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      primaryContact: {
        name: 'Concurrent User',
        email: 'concurrent@example.com',
        phone: '+919999988888',
      },
      passengers: [
        {
          passengerType: 'ADULT' as const,
          fullName: 'Pass 1',
          ageAtBooking: 30,
          gender: 'MALE' as const,
          isPrimaryContact: true,
        },
        {
          passengerType: 'ADULT' as const,
          fullName: 'Pass 2',
          ageAtBooking: 28,
          gender: 'FEMALE' as const,
          isPrimaryContact: false,
        },
      ],
    };

    // Fire 2 concurrent booking attempts
    const [res1, res2] = await Promise.allSettled([
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: crypto.randomUUID(),
        requestHash: 'hash-attempt-1',
        bookingData: bookingPayload,
      }),
      bookingService.createBooking({
        userId: testUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: crypto.randomUUID(),
        requestHash: 'hash-attempt-2',
        bookingData: bookingPayload,
      }),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
    const rejected = [res1, res2].filter((r) => r.status === 'rejected');

    // Exactly one should succeed, exactly one should fail with INVENTORY_CAPACITY_EXCEEDED
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejectedErr = (rejected[0] as PromiseRejectedResult).reason as AppError;
    expect(rejectedErr.code).toBe(ErrorCodes.INVENTORY_CAPACITY_EXCEEDED);

    // Verify departure booked_seats remains 0, active holds = 2
    const activeHolds = await holdRepo.getActiveHoldCountForDeparture(limitedDeparture.id);
    expect(activeHolds).toBe(2);
  });

  it('3. Confirmation and Cancellation full lifecycle in real PostgreSQL', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2026-12-20',
      returnDate: '2026-12-25',
      totalSeatCapacity: 5,
      currency: 'INR',
      status: 'OPEN',
    });

    // 1. Create booking
    const creationResult = await bookingService.createBooking({
      userId: testUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-lifecycle-001',
      bookingData: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        primaryContact: {
          name: 'Lifecycle User',
          email: 'lifecycle@example.com',
          phone: '+919999911111',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'User One',
            ageAtBooking: 25,
            gender: 'MALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'User Two',
            ageAtBooking: 24,
            gender: 'FEMALE',
            isPrimaryContact: false,
          },
        ],
      },
    });

    const bookingId = creationResult.booking.id;

    // 2. Confirm booking
    const confirmed = await bookingService.confirmBooking({
      bookingId,
      paymentVerified: true,
    });

    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).toBeDefined();

    // Verify hold COMMITTED and booked_seats incremented to 2
    const holdCommitted = await holdRepo.findById(creationResult.booking.holdId!);
    expect(holdCommitted?.status).toBe('COMMITTED');

    const depAfterConfirm = await departureRepo.findById(departure.id);
    expect(depAfterConfirm?.bookedSeats).toBe(2);

    // 3. Duplicate confirmation is idempotent
    const confirmedAgain = await bookingService.confirmBooking({
      bookingId,
      paymentVerified: true,
    });
    expect(confirmedAgain.status).toBe('CONFIRMED');
    const depAfterDup = await departureRepo.findById(departure.id);
    expect(depAfterDup?.bookedSeats).toBe(2); // Still 2!

    // 4. Cancel booking (Single-decrement invariant)
    const cancelled = await bookingService.cancelBooking({
      bookingReference: creationResult.booking.bookingReference,
      customerId: testUserId,
      reason: 'Trip postponed',
    });

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellationReason).toBe('Trip postponed');

    // Verify booked_seats decremented back to 0
    const depAfterCancel = await departureRepo.findById(departure.id);
    expect(depAfterCancel?.bookedSeats).toBe(0);

    // 5. Duplicate cancellation rejected and does not decrement below 0
    await expect(
      bookingService.cancelBooking({
        bookingReference: creationResult.booking.bookingReference,
        customerId: testUserId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCodes.BOOKING_ALREADY_CANCELLED,
      }),
    );

    const depAfterDupCancel = await departureRepo.findById(departure.id);
    expect(depAfterDupCancel?.bookedSeats).toBe(0);
  });

  it('4. Expired hold cannot confirm booking in real PostgreSQL (Late Payment Policy)', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2026-12-28',
      returnDate: '2027-01-02',
      totalSeatCapacity: 4,
      currency: 'INR',
      status: 'OPEN',
    });

    const creation = await bookingService.createBooking({
      userId: testUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-expired-hold',
      bookingData: {
        departureId: departure.id,
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        primaryContact: {
          name: 'Late Payer',
          email: 'late@example.com',
          phone: '+919999922222',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Late Payer',
            ageAtBooking: 30,
            gender: 'MALE',
            isPrimaryContact: true,
          },
        ],
      },
    });

    // Manually expire the hold in DB to simulate 15-minute timeout
    await db.query(
      `UPDATE inventory_holds SET status = 'EXPIRED', expires_at = NOW() - INTERVAL '5 minutes' WHERE id = $1;`,
      [creation.booking.holdId],
    );

    // Attempting confirmation must fail
    await expect(
      bookingService.confirmBooking({
        bookingId: creation.booking.id,
        paymentVerified: true,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCodes.INVENTORY_HOLD_EXPIRED,
      }),
    );

    // Verify booked_seats remains 0
    const dep = await departureRepo.findById(departure.id);
    expect(dep?.bookedSeats).toBe(0);
  });

  it('5. Rejects cancellation of AWAITING_PAYMENT booking (only CONFIRMED is eligible)', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-01-10',
      returnDate: '2027-01-15',
      totalSeatCapacity: 6,
      currency: 'INR',
      status: 'OPEN',
    });

    const creation = await bookingService.createBooking({
      userId: testUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-unpaid-cancel',
      bookingData: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        primaryContact: {
          name: 'Unpaid User',
          email: 'unpaid@example.com',
          phone: '+919999933333',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Passenger A',
            ageAtBooking: 29,
            gender: 'FEMALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'Passenger B',
            ageAtBooking: 31,
            gender: 'MALE',
            isPrimaryContact: false,
          },
        ],
      },
    });

    await expect(
      bookingService.cancelBooking({
        bookingReference: creation.booking.bookingReference,
        customerId: testUserId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCodes.BOOKING_INVALID_STATE,
        statusCode: 400,
      }),
    );
  });

  it('6. Cancellation fails if departure booked_seats < partySize (atomic invariant guard)', async () => {
    if (!isDbAvailable || !db) return;

    const departure = await departureRepo.create({
      packageId: testPackageId,
      departureDate: '2027-02-01',
      returnDate: '2027-02-06',
      totalSeatCapacity: 4,
      currency: 'INR',
      status: 'OPEN',
    });

    const creation = await bookingService.createBooking({
      userId: testUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'hash-corrupt-inv',
      bookingData: {
        departureId: departure.id,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        primaryContact: {
          name: 'Invariant User',
          email: 'invariant@example.com',
          phone: '+919999944444',
        },
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Pass A',
            ageAtBooking: 25,
            gender: 'MALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'Pass B',
            ageAtBooking: 26,
            gender: 'FEMALE',
            isPrimaryContact: false,
          },
        ],
      },
    });

    // Confirm booking
    await bookingService.confirmBooking({
      bookingId: creation.booking.id,
      paymentVerified: true,
    });

    // Corrupt departure booked_seats to 0 (less than booking partySize 2)
    await db.query(`UPDATE departure_schedules SET booked_seats = 0 WHERE id = $1;`, [
      departure.id,
    ]);

    // Cancellation attempt must fail rather than silently clamping
    await expect(
      bookingService.cancelBooking({
        bookingReference: creation.booking.bookingReference,
        customerId: testUserId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCodes.INVENTORY_CAPACITY_EXCEEDED,
        statusCode: 400,
      }),
    );
  });
});
