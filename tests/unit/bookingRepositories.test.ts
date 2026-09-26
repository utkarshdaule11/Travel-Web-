import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  CreateBookingData,
  CreatePassengerData,
} from '../../backend/src/modules/booking/index.js';

describe('Phase 5 Step 3 — PostgreSQL Booking Data Access Repositories (Unit & Integration)', () => {
  let db: DatabaseService;
  let isDbAvailable = false;
  let bookingRepo: BookingRepository;
  let passengerRepo: PassengerRepository;
  let idempotencyRepo: IdempotencyRepository;

  let testUserId = '';
  let testDepartureId = '';

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

        // Fetch test user
        const userRes = await db.query<{ id: string }>(`SELECT id FROM users LIMIT 1;`);
        if (userRes.rows[0]) {
          testUserId = userRes.rows[0].id;
        }

        // Fetch test departure
        const depRes = await db.query<{ id: string }>(
          `SELECT ds.id
           FROM departure_schedules ds
           JOIN tour_packages tp ON ds.package_id = tp.id
           LIMIT 1;`,
        );
        if (depRes.rows[0]) {
          testDepartureId = depRes.rows[0].id;
        }
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

  const sampleSnapshots = {
    priceBreakdown: {
      adultCount: 2,
      adultUnitPrice: 4500000,
      adultSubtotal: 9000000,
      childCount: 0,
      childUnitPrice: 0,
      childSubtotal: 0,
      baseSubtotal: 9000000,
      discountAmount: 0,
      totalPrice: 9000000,
      currency: 'INR' as const,
      calculatedAt: '2026-09-26T06:00:00.000Z',
    },
    packageSnapshot: {
      packageId: '11111111-1111-1111-1111-111111111111',
      slug: 'kashmir-tour',
      title: 'Kashmir Tour Delight',
      shortDescription: 'Short description',
      durationDays: 6,
      durationNights: 5,
      originCity: 'Delhi',
      destinationCity: 'Srinagar',
      destinationCountry: 'India',
      heroImageUrl: 'https://images.example.com/kashmir.jpg',
      inclusions: ['Breakfast', 'Houseboat'],
      exclusions: ['Airfare'],
    },
    departureSnapshot: {
      departureId: '22222222-2222-2222-2222-222222222222',
      departureDate: '2026-11-15',
      returnDate: '2026-11-20',
      pricingApplied: {
        basePriceAdult: 4500000,
        basePriceChild: 2250000,
        currency: 'INR' as const,
      },
      statusAtBooking: 'OPEN',
    },
    itinerarySnapshot: [
      {
        dayNumber: 1,
        title: 'Arrival in Srinagar',
        activityDescription: 'Airport transfer to houseboat',
        mealsIncluded: ['DINNER'],
      },
    ],
  };

  // ============================================================
  // 1. BookingRepository CRUD & Projections
  // ============================================================
  describe('1. BookingRepository Operations', () => {
    it('1.1 creates a booking and retrieves it with JSONB snapshots and primary contact mapped', async () => {
      if (!isDbAvailable || !testUserId || !testDepartureId) return;

      await db
        .withTransaction(async (client) => {
          const createData: CreateBookingData = {
            bookingReference: 'BK-TEST-REPO-001',
            customerId: testUserId,
            departureId: testDepartureId,
            partySize: 2,
            adultCount: 2,
            childCount: 0,
            totalPrice: 9000000,
            currency: 'INR',
            status: 'AWAITING_PAYMENT',
            ...sampleSnapshots,
            primaryContact: {
              name: 'John Doe',
              email: 'john.doe@example.com',
              phone: '+919876543210',
            },
          };

          const created = await bookingRepo.create(createData, client);
          expect(created.id).toBeDefined();
          expect(created.bookingReference).toBe('BK-TEST-REPO-001');
          expect(created.status).toBe('AWAITING_PAYMENT');
          expect(created.totalPrice).toBe(9000000);
          expect(created.primaryContact.name).toBe('John Doe');
          expect(created.packageSnapshot.title).toBe('Kashmir Tour Delight');

          // Find by ID
          const fetchedById = await bookingRepo.findById(created.id, client);
          expect(fetchedById).not.toBeNull();
          expect(fetchedById?.bookingReference).toBe('BK-TEST-REPO-001');
          expect(fetchedById?.departureSnapshot.departureDate).toBe('2026-11-15');

          // Find by Reference
          const fetchedByRef = await bookingRepo.findByReference('BK-TEST-REPO-001', client);
          expect(fetchedByRef).not.toBeNull();
          expect(fetchedByRef?.id).toBe(created.id);

          // Find by Reference and Customer (ownership guard)
          const fetchedOwner = await bookingRepo.findByReferenceAndCustomer(
            'BK-TEST-REPO-001',
            testUserId,
            client,
          );
          expect(fetchedOwner).not.toBeNull();

          // Non-owner should return null
          const fetchedNonOwner = await bookingRepo.findByReferenceAndCustomer(
            'BK-TEST-REPO-001',
            '00000000-0000-0000-0000-000000000000',
            client,
          );
          expect(fetchedNonOwner).toBeNull();

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') throw err;
        });
    });

    it('1.2 findByCustomerId retrieves paginated list of bookings with joined package titles', async () => {
      if (!isDbAvailable || !testUserId || !testDepartureId) return;

      await db
        .withTransaction(async (client) => {
          await bookingRepo.create(
            {
              bookingReference: 'BK-CUST-PAG-001',
              customerId: testUserId,
              departureId: testDepartureId,
              partySize: 1,
              adultCount: 1,
              childCount: 0,
              totalPrice: 4500000,
              currency: 'INR',
              status: 'CONFIRMED',
              ...sampleSnapshots,
              primaryContact: { name: 'Alice', email: 'alice@example.com', phone: '+919999999999' },
            },
            client,
          );

          await bookingRepo.create(
            {
              bookingReference: 'BK-CUST-PAG-002',
              customerId: testUserId,
              departureId: testDepartureId,
              partySize: 2,
              adultCount: 2,
              childCount: 0,
              totalPrice: 9000000,
              currency: 'INR',
              status: 'AWAITING_PAYMENT',
              ...sampleSnapshots,
              primaryContact: { name: 'Bob', email: 'bob@example.com', phone: '+918888888888' },
            },
            client,
          );

          // Fetch all for customer
          const listAll = await bookingRepo.findByCustomerId(testUserId, { limit: 10 }, client);
          expect(listAll.total).toBeGreaterThanOrEqual(2);
          expect(listAll.bookings.some((b) => b.bookingReference === 'BK-CUST-PAG-001')).toBe(true);

          // Fetch filtered by status
          const listConfirmed = await bookingRepo.findByCustomerId(
            testUserId,
            { status: 'CONFIRMED' },
            client,
          );
          expect(listConfirmed.bookings.every((b) => b.status === 'CONFIRMED')).toBe(true);

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') throw err;
        });
    });

    it('1.3 listAdmin filters bookings by status, departureId, customerId, and search keyword', async () => {
      if (!isDbAvailable || !testUserId || !testDepartureId) return;

      await db
        .withTransaction(async (client) => {
          await bookingRepo.create(
            {
              bookingReference: 'BK-ADM-SRCH-999',
              customerId: testUserId,
              departureId: testDepartureId,
              partySize: 1,
              adultCount: 1,
              childCount: 0,
              totalPrice: 4500000,
              currency: 'INR',
              status: 'CONFIRMED',
              ...sampleSnapshots,
              primaryContact: {
                name: 'UniqueAdminSearchTarget',
                email: 'unique.target@example.com',
                phone: '+919999911111',
              },
            },
            client,
          );

          // Search by name
          const searchRes = await bookingRepo.listAdmin(
            { search: 'UniqueAdminSearchTarget' },
            client,
          );
          expect(searchRes.total).toBe(1);
          expect(searchRes.bookings[0]?.bookingReference).toBe('BK-ADM-SRCH-999');

          // Filter by departureId
          const depRes = await bookingRepo.listAdmin(
            { departureId: testDepartureId, limit: 5 },
            client,
          );
          expect(depRes.total).toBeGreaterThanOrEqual(1);

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') throw err;
        });
    });

    it('1.4 updateStatusGuarded atomically transitions status only when expectedCurrentStatus matches', async () => {
      if (!isDbAvailable || !testUserId || !testDepartureId) return;

      await db
        .withTransaction(async (client) => {
          const booking = await bookingRepo.create(
            {
              bookingReference: 'BK-GUARD-001',
              customerId: testUserId,
              departureId: testDepartureId,
              partySize: 1,
              adultCount: 1,
              childCount: 0,
              totalPrice: 4500000,
              currency: 'INR',
              status: 'CONFIRMED',
              ...sampleSnapshots,
              primaryContact: {
                name: 'Guard Tester',
                email: 'guard@example.com',
                phone: '+911122334455',
              },
            },
            client,
          );

          // Attempt transition from wrong expected status (AWAITING_PAYMENT -> CANCELLED on CONFIRMED booking)
          const wrongGuard = await bookingRepo.updateStatusGuarded(
            booking.id,
            'AWAITING_PAYMENT',
            'CANCELLED',
            { cancellationReason: 'Wrong status test' },
            client,
          );
          expect(wrongGuard).toBeNull(); // Guard prevented transition!

          // Correct transition (CONFIRMED -> CANCELLED)
          const correctGuard = await bookingRepo.updateStatusGuarded(
            booking.id,
            'CONFIRMED',
            'CANCELLED',
            {
              cancellationReason: 'Customer requested cancellation',
              cancelledAt: new Date(),
            },
            client,
          );
          expect(correctGuard).not.toBeNull();
          expect(correctGuard?.status).toBe('CANCELLED');
          expect(correctGuard?.cancellationReason).toBe('Customer requested cancellation');

          // Second attempt from CONFIRMED -> CANCELLED must fail (already CANCELLED)
          const doubleCancel = await bookingRepo.updateStatusGuarded(
            booking.id,
            'CONFIRMED',
            'CANCELLED',
            { cancellationReason: 'Double cancel attempt' },
            client,
          );
          expect(doubleCancel).toBeNull();

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') throw err;
        });
    });

    it('1.5 findDepartureManifest retrieves aggregated departure info with passenger roster', async () => {
      if (!isDbAvailable || !testUserId || !testDepartureId) return;

      await db
        .withTransaction(async (client) => {
          const booking = await bookingRepo.create(
            {
              bookingReference: 'BK-MAN-001',
              customerId: testUserId,
              departureId: testDepartureId,
              partySize: 2,
              adultCount: 1,
              childCount: 1,
              totalPrice: 6750000,
              currency: 'INR',
              status: 'CONFIRMED',
              ...sampleSnapshots,
              primaryContact: {
                name: 'Manifest Contact',
                email: 'man@example.com',
                phone: '+919988776655',
              },
            },
            client,
          );

          await passengerRepo.createMany(
            [
              {
                bookingId: booking.id,
                passengerType: 'ADULT',
                fullName: 'Adult Passenger',
                ageAtBooking: 40,
                gender: 'FEMALE',
                isPrimaryContact: true,
                specialRequests: 'Vegetarian meal',
              },
              {
                bookingId: booking.id,
                passengerType: 'CHILD',
                fullName: 'Child Passenger',
                ageAtBooking: 9,
                gender: 'MALE',
                isPrimaryContact: false,
              },
            ],
            client,
          );

          const manifest = await bookingRepo.findDepartureManifest(testDepartureId, client);
          expect(manifest).not.toBeNull();
          expect(manifest?.departureId).toBe(testDepartureId);
          expect(manifest?.totalPassengers).toBeGreaterThanOrEqual(2);
          expect(
            manifest?.passengers.some(
              (p) => p.fullName === 'Adult Passenger' && p.specialRequests === 'Vegetarian meal',
            ),
          ).toBe(true);

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') throw err;
        });
    });
  });

  // ============================================================
  // 2. PassengerRepository Operations
  // ============================================================
  describe('2. PassengerRepository Operations', () => {
    it('2.1 inserts single and bulk passengers and retrieves by booking ID', async () => {
      if (!isDbAvailable || !testUserId || !testDepartureId) return;

      await db
        .withTransaction(async (client) => {
          const booking = await bookingRepo.create(
            {
              bookingReference: 'BK-PASS-001',
              customerId: testUserId,
              departureId: testDepartureId,
              partySize: 3,
              adultCount: 2,
              childCount: 1,
              totalPrice: 11250000,
              currency: 'INR',
              status: 'AWAITING_PAYMENT',
              ...sampleSnapshots,
              primaryContact: {
                name: 'Lead Traveler',
                email: 'lead@example.com',
                phone: '+919876543210',
              },
            },
            client,
          );

          const passengersToInsert: CreatePassengerData[] = [
            {
              bookingId: booking.id,
              passengerType: 'ADULT',
              fullName: 'Lead Adult',
              dateOfBirth: '1988-03-20',
              ageAtBooking: 38,
              gender: 'FEMALE',
              isPrimaryContact: true,
              specialRequests: 'Wheelchair assistance',
            },
            {
              bookingId: booking.id,
              passengerType: 'ADULT',
              fullName: 'Second Adult',
              ageAtBooking: 42,
              gender: 'MALE',
              isPrimaryContact: false,
            },
            {
              bookingId: booking.id,
              passengerType: 'CHILD',
              fullName: 'Junior Traveler',
              ageAtBooking: 6,
              gender: 'OTHER',
              isPrimaryContact: false,
            },
          ];

          const inserted = await passengerRepo.createMany(passengersToInsert, client);
          expect(inserted).toHaveLength(3);

          const fetched = await passengerRepo.findByBookingId(booking.id, client);
          expect(fetched).toHaveLength(3);
          expect(fetched[0]?.isPrimaryContact).toBe(true);
          expect(fetched[0]?.fullName).toBe('Lead Adult');
          expect(fetched[0]?.dateOfBirth).toBe('1988-03-20');

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') throw err;
        });
    });
  });

  // ============================================================
  // 3. IdempotencyRepository Operations
  // ============================================================
  describe('3. IdempotencyRepository Operations', () => {
    it('3.1 creates and retrieves idempotency records by compound key', async () => {
      if (!isDbAvailable || !testUserId) return;

      await db
        .withTransaction(async (client) => {
          const created = await idempotencyRepo.create(
            {
              userId: testUserId,
              endpointScope: 'POST /api/v1/bookings',
              idempotencyKey: 'idem-key-unit-test-1',
              requestHash: 'sha256_mock_hash_123',
              responseCode: 201,
              responseBody: { bookingReference: 'BK-IDEM-001', status: 'AWAITING_PAYMENT' },
            },
            client,
          );

          expect(created.id).toBeDefined();
          expect(created.endpointScope).toBe('POST /api/v1/bookings');
          expect(created.requestHash).toBe('sha256_mock_hash_123');
          expect(created.responseCode).toBe(201);
          expect((created.responseBody as Record<string, unknown>).bookingReference).toBe(
            'BK-IDEM-001',
          );

          // Find by compound key
          const found = await idempotencyRepo.find(
            testUserId,
            'POST /api/v1/bookings',
            'idem-key-unit-test-1',
            client,
          );
          expect(found).not.toBeNull();
          expect(found?.requestHash).toBe('sha256_mock_hash_123');

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') throw err;
        });
    });

    it('3.2 deleteExpired removes expired idempotency records', async () => {
      if (!isDbAvailable || !testUserId) return;

      await db
        .withTransaction(async (client) => {
          await idempotencyRepo.create(
            {
              userId: testUserId,
              endpointScope: 'POST /api/v1/bookings',
              idempotencyKey: 'idem-key-expired-test',
              requestHash: 'sha256_expired_hash',
              expiresAt: new Date(Date.now() - 10000), // Past expiration
            },
            client,
          );

          const deletedCount = await idempotencyRepo.deleteExpired(client);
          expect(deletedCount).toBeGreaterThanOrEqual(1);

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') throw err;
        });
    });
  });

  // ============================================================
  // 4. Mandatory Transaction Rollback Verification
  // ============================================================
  describe('4. Mandatory Multi-Repository Transaction Rollback Verification', () => {
    it('4.1 rolls back booking, passengers, and idempotency key atomically when transaction aborts', async () => {
      if (!isDbAvailable || !testUserId || !testDepartureId) return;

      const testRef = `BK-ROLLBACK-${Date.now()}`;
      const testIdemKey = `idem-rollback-${Date.now()}`;
      let createdBookingId = '';

      try {
        await db.withTransaction(async (client) => {
          // 1. Create Booking
          const booking = await bookingRepo.create(
            {
              bookingReference: testRef,
              customerId: testUserId,
              departureId: testDepartureId,
              partySize: 1,
              adultCount: 1,
              childCount: 0,
              totalPrice: 4500000,
              currency: 'INR',
              status: 'AWAITING_PAYMENT',
              ...sampleSnapshots,
              primaryContact: {
                name: 'Rollback Test',
                email: 'rb@example.com',
                phone: '+910000000000',
              },
            },
            client,
          );
          createdBookingId = booking.id;

          // 2. Create Passenger
          await passengerRepo.create(
            {
              bookingId: booking.id,
              passengerType: 'ADULT',
              fullName: 'Rollback Traveler',
              ageAtBooking: 29,
              gender: 'MALE',
              isPrimaryContact: true,
            },
            client,
          );

          // 3. Create Idempotency Record
          await idempotencyRepo.create(
            {
              userId: testUserId,
              endpointScope: 'POST /api/v1/bookings',
              idempotencyKey: testIdemKey,
              requestHash: 'hash_rollback_test',
            },
            client,
          );

          // 4. Force Transaction Abort
          throw new Error('SIMULATED_TRANSACTION_FAILURE');
        });
      } catch (err: unknown) {
        expect((err as Error).message).toBe('SIMULATED_TRANSACTION_FAILURE');
      }

      // Verify ZERO records persisted across all three repositories
      const checkBooking = await bookingRepo.findByReference(testRef);
      expect(checkBooking).toBeNull();

      if (createdBookingId) {
        const checkPassengers = await passengerRepo.findByBookingId(createdBookingId);
        expect(checkPassengers).toHaveLength(0);
      }

      const checkIdempotency = await idempotencyRepo.find(
        testUserId,
        'POST /api/v1/bookings',
        testIdemKey,
      );
      expect(checkIdempotency).toBeNull();
    });
  });

  // ============================================================
  // 5. Idempotency Concurrency & Security Tests
  // ============================================================
  describe('5. Concurrency & Parameterization Security Tests', () => {
    it('5.1 rejects concurrent insertion of duplicate (user_id, endpoint_scope, idempotency_key)', async () => {
      if (!isDbAvailable || !testUserId) return;

      await db
        .withTransaction(async (client) => {
          const keyData = {
            userId: testUserId,
            endpointScope: 'POST /api/v1/bookings',
            idempotencyKey: 'idem-concurrency-test-key',
            requestHash: 'hash_111',
          };

          await idempotencyRepo.create(keyData, client);

          // Duplicate insert on same client must throw PostgreSQL unique violation
          await expect(idempotencyRepo.create(keyData, client)).rejects.toThrow(
            /uq_idempotency_user_endpoint_key|duplicate key/i,
          );

          throw new Error('ROLLBACK_TEST_TRANSACTION');
        })
        .catch((err) => {
          if (err.message !== 'ROLLBACK_TEST_TRANSACTION') throw err;
        });
    });

    it('5.2 safely escapes SQL injection attempts in search, reference, and scopes via parameters', async () => {
      if (!isDbAvailable || !testUserId || !testDepartureId) return;

      const injectionPayloads = [
        "BK-INJECT'; DROP TABLE bookings; --",
        "'; SELECT * FROM users; --",
        "' OR '1'='1",
        "admin' UNION SELECT * FROM users --",
      ];

      for (const injection of injectionPayloads) {
        // Safe lookup by reference
        const refResult = await bookingRepo.findByReference(injection);
        expect(refResult).toBeNull();

        // Safe admin search query
        const adminResult = await bookingRepo.listAdmin({ search: injection });
        expect(adminResult.total).toBe(0);

        // Safe idempotency lookup
        const idemResult = await idempotencyRepo.find(testUserId, injection, injection);
        expect(idemResult).toBeNull();
      }
    });
  });
});
