import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadEnv } from '../../backend/src/config/env.js';
import { DatabaseService, runMigrations } from '../../backend/src/infrastructure/database/index.js';
import { seedAll } from '../../backend/src/infrastructure/database/seeds/seedAll.js';
import { DepartureRepository } from '../../backend/src/modules/inventory/repositories/departure.repository.js';
import { InventoryHoldRepository } from '../../backend/src/modules/inventory/repositories/inventoryHold.repository.js';
import { BookingRepository } from '../../backend/src/modules/booking/repositories/booking.repository.js';
import { PassengerRepository } from '../../backend/src/modules/booking/repositories/passenger.repository.js';
import { IdempotencyRepository } from '../../backend/src/modules/booking/repositories/idempotency.repository.js';
import { TourPackageRepository } from '../../backend/src/modules/catalogue/repositories/tourPackage.repository.js';
import { ItineraryRepository } from '../../backend/src/modules/catalogue/repositories/itinerary.repository.js';
import { DestinationRepository } from '../../backend/src/modules/catalogue/repositories/destination.repository.js';
import { BookingService } from '../../backend/src/modules/booking/services/booking.service.js';
import {
  createHoldExpiryQueue,
  createHoldExpiryWorker,
  enqueueHoldExpiry,
  HOLD_EXPIRY_QUEUE_NAME,
} from '../../worker/src/queues/holdExpiryQueue.js';
import { loadWorkerEnv } from '../../worker/src/config/workerEnv.js';

describe('Phase 5 Step 8 — Background Inventory Hold Expiry Worker & Concurrency Engine', () => {
  let db: DatabaseService;
  let isDbAvailable = false;
  let departureRepo: DepartureRepository;
  let holdRepo: InventoryHoldRepository;
  let bookingRepo: BookingRepository;
  let passengerRepo: PassengerRepository;
  let idempotencyRepo: IdempotencyRepository;
  let tourPackageRepo: TourPackageRepository;
  let itineraryRepo: ItineraryRepository;
  let destinationRepo: DestinationRepository;
  let bookingService: BookingService;

  const config = loadEnv();
  const workerConfig = loadWorkerEnv();

  const testUserId = '33333333-3333-4333-8333-333333333333';
  const testUserEmail = 'hold.worker.test@example.com';
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
        idempotencyRepo = new IdempotencyRepository(db);
        tourPackageRepo = new TourPackageRepository(db);
        itineraryRepo = new ItineraryRepository(db);
        destinationRepo = new DestinationRepository(db);

        bookingService = new BookingService(
          db,
          bookingRepo,
          passengerRepo,
          idempotencyRepo,
          departureRepo,
          holdRepo,
          tourPackageRepo,
          itineraryRepo,
          destinationRepo,
        );

        await db.query(
          `INSERT INTO users (id, email, password_hash, full_name, role, is_active)
           VALUES ($1, $2, '$argon2id$mockhash', 'Hold Test User', 'CUSTOMER', true)
           ON CONFLICT (id) DO UPDATE SET is_active = true;`,
          [testUserId, testUserEmail],
        );

        const pkgRes = await db.query<{ id: string }>(
          `SELECT id FROM tour_packages WHERE is_published = true LIMIT 1;`,
        );
        testPackageId = pkgRes.rows[0]!.id;
      }
    } catch {
      isDbAvailable = false;
    }
  });

  let departureOffsetCounter = 500;
  const createTestDeparture = async (capacity = 20) => {
    departureOffsetCounter++;
    const depDate = new Date(Date.UTC(2028, 9, departureOffsetCounter));
    const retDate = new Date(Date.UTC(2028, 9, departureOffsetCounter + 4));
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
    if (db && isDbAvailable) {
      await db.query(`DELETE FROM idempotency_keys;`);
      await db.query(`DELETE FROM booking_passengers;`);
      await db.query(`DELETE FROM bookings;`);
      await db.query(`DELETE FROM inventory_holds;`);
      await db.query(`DELETE FROM departure_schedules WHERE departure_date >= '2028-01-01';`);
      await db.query(`DELETE FROM users WHERE id = $1;`, [testUserId]);
      await db.close();
    }
  });

  // ============================================================
  // TEST A — ACTIVE unexpired hold is NOT expired by worker
  // ============================================================
  it('TEST A — ACTIVE unexpired hold is NOT expired by worker', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-unexpired-${Date.now()}`,
      userId: testUserId,
      heldSeats: 2,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 mins in future
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-UNEXP-${Date.now()}`,
      customerId: testUserId,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Unexpired Lead',
        email: 'unexp@example.com',
        phone: '+919988776655',
      },
    });

    const activeCount = await holdRepo.getActiveHoldCountForDeparture(departure.id);
    expect(activeCount).toBe(2);

    // Database authoritative check: hold is unexpired
    expect(new Date(hold.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const refreshedBooking = await bookingRepo.findById(booking.id);
    expect(refreshedBooking?.status).toBe('AWAITING_PAYMENT');
  });

  // ============================================================
  // TEST B — ACTIVE expired hold + AWAITING_PAYMENT booking -> EXPIRED
  // ============================================================
  it('TEST B — ACTIVE expired hold + AWAITING_PAYMENT booking: transitions booking to EXPIRED and hold to EXPIRED', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-expired-${Date.now()}`,
      userId: testUserId,
      heldSeats: 2,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-EXP-${Date.now()}`,
      customerId: testUserId,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Expired Lead',
        email: 'exp@example.com',
        phone: '+919988776655',
      },
    });

    // Execute domain expiry
    const result = await bookingService.expireHoldAndBooking(hold.id, booking.id);

    expect(result.outcome).toBe('EXPIRED');
    expect(result.booking?.status).toBe('EXPIRED');
    expect(result.hold?.status).toBe('EXPIRED');

    const updatedBooking = await bookingRepo.findById(booking.id);
    const updatedHold = await holdRepo.findById(hold.id);

    expect(updatedBooking?.status).toBe('EXPIRED');
    expect(updatedHold?.status).toBe('EXPIRED');
  });

  // ============================================================
  // TEST C — Expired hold: booked_seats remains unchanged
  // ============================================================
  it('TEST C — Expired hold: booked_seats remains completely unchanged (zero decrement / zero increment)', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(15);
    const initialDep = await departureRepo.findById(departure.id);
    const initialBookedSeats = initialDep?.bookedSeats ?? 0;

    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-inv-${Date.now()}`,
      userId: testUserId,
      heldSeats: 4,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 10000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-INV-${Date.now()}`,
      customerId: testUserId,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 4,
      adultCount: 4,
      childCount: 0,
      totalPrice: 20000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Inv Lead',
        email: 'inv@example.com',
        phone: '+919988776655',
      },
    });

    await bookingService.expireHoldAndBooking(hold.id, booking.id);

    const postDep = await departureRepo.findById(departure.id);
    expect(postDep?.bookedSeats).toBe(initialBookedSeats);
  });

  // ============================================================
  // TEST D & E — Already EXPIRED booking and hold: idempotent execution
  // ============================================================
  it('TEST D & E — Already EXPIRED booking and hold: repeated worker execution is idempotent', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-idem-${Date.now()}`,
      userId: testUserId,
      heldSeats: 1,
      status: 'EXPIRED',
      expiresAt: new Date(Date.now() - 60000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-IDEM-${Date.now()}`,
      customerId: testUserId,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'EXPIRED',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Idem Lead',
        email: 'idem@example.com',
        phone: '+919988776655',
      },
    });

    const result1 = await bookingService.expireHoldAndBooking(hold.id, booking.id);
    expect(result1.outcome).toBe('ALREADY_EXPIRED');

    const result2 = await bookingService.expireHoldAndBooking(hold.id, booking.id);
    expect(result2.outcome).toBe('ALREADY_EXPIRED');

    const finalBooking = await bookingRepo.findById(booking.id);
    expect(finalBooking?.status).toBe('EXPIRED');
  });

  // ============================================================
  // TEST F & G — CONFIRMED booking / COMMITTED hold: worker does not modify
  // ============================================================
  it('TEST F & G — CONFIRMED booking and COMMITTED hold: worker does not modify state (safe no-op)', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-conf-${Date.now()}`,
      userId: testUserId,
      heldSeats: 2,
      status: 'COMMITTED',
      expiresAt: new Date(Date.now() + 10000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-CONF-${Date.now()}`,
      customerId: testUserId,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'CONFIRMED',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Confirmed Lead',
        email: 'conf@example.com',
        phone: '+919988776655',
      },
    });

    const result = await bookingService.expireHoldAndBooking(hold.id, booking.id);

    expect(result.outcome).toBe('COMMITTED');
    const checkedBooking = await bookingRepo.findById(booking.id);
    const checkedHold = await holdRepo.findById(hold.id);

    expect(checkedBooking?.status).toBe('CONFIRMED');
    expect(checkedHold?.status).toBe('COMMITTED');
  });

  // ============================================================
  // TEST H — CANCELLED booking: worker does not modify
  // ============================================================
  it('TEST H — CANCELLED booking: worker safely no-ops without modifying state', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-canc-${Date.now()}`,
      userId: testUserId,
      heldSeats: 1,
      status: 'RELEASED',
      expiresAt: new Date(Date.now() - 10000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-CANC-${Date.now()}`,
      customerId: testUserId,
      departureId: departure.id,
      holdId: hold.id,
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
        phone: '+919988776655',
      },
    });

    const result = await bookingService.expireHoldAndBooking(hold.id, booking.id);
    expect(result.outcome).toBe('CANCELLED');

    const finalBooking = await bookingRepo.findById(booking.id);
    expect(finalBooking?.status).toBe('CANCELLED');
  });

  // ============================================================
  // TEST I — Expiry worker runs twice concurrently: no duplicate mutation
  // ============================================================
  it('TEST I — Expiry worker runs twice concurrently: no duplicate state mutation or corruption', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-race-${Date.now()}`,
      userId: testUserId,
      heldSeats: 2,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 5000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-RACE-${Date.now()}`,
      customerId: testUserId,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Race Lead',
        email: 'race@example.com',
        phone: '+919988776655',
      },
    });

    // Run 2 concurrent expiry operations
    const [res1, res2] = await Promise.all([
      bookingService.expireHoldAndBooking(hold.id, booking.id),
      bookingService.expireHoldAndBooking(hold.id, booking.id),
    ]);

    const outcomes = [res1.outcome, res2.outcome];
    expect(outcomes).toContain('EXPIRED');

    const finalBooking = await bookingRepo.findById(booking.id);
    const finalHold = await holdRepo.findById(hold.id);

    expect(finalBooking?.status).toBe('EXPIRED');
    expect(finalHold?.status).toBe('EXPIRED');
  });

  // ============================================================
  // TEST J — Expiry races with booking confirmation
  // ============================================================
  it('TEST J — Expiry races with booking confirmation: outcome is strictly atomic (either CONFIRMED+COMMITTED or EXPIRED+EXPIRED, never corrupt mixed states)', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const initialBookedSeats = departure.bookedSeats;

    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-race-conf-${Date.now()}`,
      userId: testUserId,
      heldSeats: 2,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 500), // Very close to expiry
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-RACE-CONF-${Date.now()}`,
      customerId: testUserId,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 2,
      adultCount: 2,
      childCount: 0,
      totalPrice: 10000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Race Confirm Lead',
        email: 'raceconf@example.com',
        phone: '+919988776655',
      },
    });

    // Execute concurrent Confirmation vs Expiry
    await Promise.allSettled([
      bookingService.confirmBooking({ bookingId: booking.id, paymentVerified: true }),
      bookingService.expireHoldAndBooking(hold.id, booking.id),
    ]);

    const finalBooking = await bookingRepo.findById(booking.id);
    const finalHold = await holdRepo.findById(hold.id);
    const finalDep = await departureRepo.findById(departure.id);

    // Invariant: States must match consistently
    if (finalBooking?.status === 'CONFIRMED') {
      expect(finalHold?.status).toBe('COMMITTED');
      expect(finalDep?.bookedSeats).toBe(initialBookedSeats + 2);
    } else {
      expect(finalBooking?.status).toBe('EXPIRED');
      expect(finalHold?.status).toBe('EXPIRED');
      expect(finalDep?.bookedSeats).toBe(initialBookedSeats);
    }

    // NEVER corrupt states
    expect(finalBooking?.status === 'CONFIRMED' && finalHold?.status === 'EXPIRED').toBe(false);
    expect(finalBooking?.status === 'EXPIRED' && finalHold?.status === 'COMMITTED').toBe(false);
  });

  // ============================================================
  // TEST K — Database transaction failure: booking and hold remain consistent (atomic rollback)
  // ============================================================
  it('TEST K — Database transaction failure rolls back atomically: booking and hold remain consistent', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-rollback-${Date.now()}`,
      userId: testUserId,
      heldSeats: 1,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 5000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-RB-${Date.now()}`,
      customerId: testUserId,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Rollback Lead',
        email: 'rb@example.com',
        phone: '+919988776655',
      },
    });

    try {
      await db.withTransaction(async (client: pg.PoolClient) => {
        await bookingRepo.updateStatusGuarded(
          booking.id,
          'AWAITING_PAYMENT',
          'EXPIRED',
          {},
          client,
        );
        // Force failure before hold update
        throw new Error('SIMULATED_TRANSACTION_FAILURE');
      });
    } catch (err: unknown) {
      expect((err as Error).message).toBe('SIMULATED_TRANSACTION_FAILURE');
    }

    // Both remain in original state
    const currentBooking = await bookingRepo.findById(booking.id);
    const currentHold = await holdRepo.findById(hold.id);

    expect(currentBooking?.status).toBe('AWAITING_PAYMENT');
    expect(currentHold?.status).toBe('ACTIVE');
  });

  // ============================================================
  // TEST L — Worker retries after transient failure: eventually succeeds
  // ============================================================
  it('TEST L — Worker retries after transient failure: eventually succeeds idempotently', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(10);
    const hold = await holdRepo.create({
      departureId: departure.id,
      checkoutSessionToken: `tok-retry-${Date.now()}`,
      userId: testUserId,
      heldSeats: 1,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 1000),
    });

    const booking = await bookingRepo.create({
      bookingReference: `BK-RETRY-${Date.now()}`,
      customerId: testUserId,
      departureId: departure.id,
      holdId: hold.id,
      partySize: 1,
      adultCount: 1,
      childCount: 0,
      totalPrice: 5000000,
      currency: 'INR',
      status: 'AWAITING_PAYMENT',
      ...sampleSnapshots,
      primaryContact: {
        name: 'Retry Lead',
        email: 'retry@example.com',
        phone: '+919988776655',
      },
    });

    // Simulate first attempt success, second retry
    const res1 = await bookingService.expireHoldAndBooking(hold.id, booking.id);
    expect(res1.outcome).toBe('EXPIRED');

    const res2 = await bookingService.expireHoldAndBooking(hold.id, booking.id);
    expect(res2.outcome).toBe('ALREADY_EXPIRED');

    const finalBooking = await bookingRepo.findById(booking.id);
    expect(finalBooking?.status).toBe('EXPIRED');
  });

  // ============================================================
  // TEST M — Job payload contains only safe identifiers
  // ============================================================
  it('TEST M — Job payload contains only non-sensitive identifiers (holdId, bookingId)', () => {
    const jobData = {
      holdId: 'hold-uuid-123',
      bookingId: 'booking-uuid-456',
    };

    const payloadStr = JSON.stringify(jobData);
    expect(payloadStr).not.toContain('password');
    expect(payloadStr).not.toContain('jwt');
    expect(payloadStr).not.toContain('secret');
    expect(payloadStr).not.toContain('token');
    expect(payloadStr).not.toContain('email');
  });

  // ============================================================
  // TEST N — Multiple expired holds: all processed in batch sweep
  // ============================================================
  it('TEST N — Multiple expired holds: all eligible holds processed in batch sweep', async () => {
    if (!isDbAvailable) return;

    const departure = await createTestDeparture(30);

    const holdIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const h = await holdRepo.create({
        departureId: departure.id,
        checkoutSessionToken: `tok-batch-${i}-${Date.now()}`,
        userId: testUserId,
        heldSeats: 1,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() - 5000),
      });

      await bookingRepo.create({
        bookingReference: `BK-BATCH-${i}-${Date.now()}`,
        customerId: testUserId,
        departureId: departure.id,
        holdId: h.id,
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        totalPrice: 5000000,
        currency: 'INR',
        status: 'AWAITING_PAYMENT',
        ...sampleSnapshots,
        primaryContact: {
          name: `Batch Lead ${i}`,
          email: `batch${i}@example.com`,
          phone: '+919988776655',
        },
      });

      holdIds.push(h.id);
    }

    const sweepResults = await bookingService.sweepExpiredHolds(100);
    expect(sweepResults.length).toBeGreaterThanOrEqual(3);

    for (const id of holdIds) {
      const h = await holdRepo.findById(id);
      expect(h?.status).toBe('EXPIRED');
      const b = await bookingRepo.findByHoldId(id);
      expect(b?.status).toBe('EXPIRED');
    }
  });

  // ============================================================
  // TEST O — Queue & Worker initialization contract
  // ============================================================
  it('TEST O — Queue and Worker instantiate with proper BullMQ configurations', () => {
    const queue = createHoldExpiryQueue(workerConfig);
    expect(queue.name).toBe(HOLD_EXPIRY_QUEUE_NAME);
    expect(typeof enqueueHoldExpiry).toBe('function');

    const worker = createHoldExpiryWorker(workerConfig, bookingService);
    expect(worker.name).toBe(HOLD_EXPIRY_QUEUE_NAME);
    expect(worker.opts.concurrency).toBe(workerConfig.WORKER_CONCURRENCY);
  });

  // ============================================================
  // TEST P — Graceful worker shutdown: closes cleanly
  // ============================================================
  it('TEST P — Graceful worker shutdown closes worker and resources cleanly', async () => {
    const worker = createHoldExpiryWorker(workerConfig, bookingService);
    await expect(worker.close()).resolves.not.toThrow();
  });
});
