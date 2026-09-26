import { describe, it, expect, vi, beforeEach } from 'vitest';
import type pg from 'pg';
import {
  CreateBookingDto,
  DepartureStatus,
  ErrorCodes,
  SupportedCurrency,
} from '../../shared/src/index.js';
import { DatabaseService } from '../../backend/src/infrastructure/database/index.js';
import {
  BookingEntity,
  BookingRepository,
} from '../../backend/src/modules/booking/repositories/booking.repository.js';
import { PassengerRepository } from '../../backend/src/modules/booking/repositories/passenger.repository.js';
import { IdempotencyRepository } from '../../backend/src/modules/booking/repositories/idempotency.repository.js';
import {
  DepartureEntity,
  DepartureRepository,
} from '../../backend/src/modules/inventory/repositories/departure.repository.js';
import {
  InventoryHoldEntity,
  InventoryHoldRepository,
} from '../../backend/src/modules/inventory/repositories/inventoryHold.repository.js';
import {
  TourPackageEntity,
  TourPackageRepository,
} from '../../backend/src/modules/catalogue/repositories/tourPackage.repository.js';
import {
  ItineraryDayEntity,
  ItineraryRepository,
} from '../../backend/src/modules/catalogue/repositories/itinerary.repository.js';
import {
  DestinationEntity,
  DestinationRepository,
} from '../../backend/src/modules/catalogue/repositories/destination.repository.js';
import {
  BookingService,
  CreateBookingCommand,
} from '../../backend/src/modules/booking/services/booking.service.js';

describe('Phase 5 Step 4 — Booking Domain & Business Rule Services', () => {
  let mockDb: DatabaseService;
  let mockBookingRepo: BookingRepository;
  let mockPassengerRepo: PassengerRepository;
  let mockIdempotencyRepo: IdempotencyRepository;
  let mockDepartureRepo: DepartureRepository;
  let mockInventoryHoldRepo: InventoryHoldRepository;
  let mockPackageRepo: TourPackageRepository;
  let mockItineraryRepo: ItineraryRepository;
  let mockDestinationRepo: DestinationRepository;

  let bookingService: BookingService;

  // Sample Fixture Data
  const sampleUserId = 'u1111111-1111-1111-1111-111111111111';
  const samplePackageId = 'p2222222-2222-2222-2222-222222222222';
  const sampleDestinationId = 'd3333333-3333-3333-3333-333333333333';
  const sampleDepartureId = 'dep44444-4444-4444-4444-444444444444';
  const sampleHoldId = 'h5555555-5555-5555-5555-555555555555';
  const sampleBookingId = 'b6666666-6666-6666-6666-666666666666';
  const sampleBookingRef = 'BK-20261115-A1B2';

  const mockDeparture: DepartureEntity = {
    id: sampleDepartureId,
    packageId: samplePackageId,
    departureDate: '2026-11-15',
    returnDate: '2026-11-20',
    totalSeatCapacity: 20,
    bookedSeats: 5,
    priceOverrideAdult: 4800000, // 48,000 INR
    priceOverrideChild: 2700000, // 27,000 INR
    currency: 'INR',
    status: 'OPEN',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };

  const mockPackage: TourPackageEntity = {
    id: samplePackageId,
    destinationId: sampleDestinationId,
    themeId: null,
    slug: 'golden-triangle-luxury',
    title: 'Golden Triangle Luxury Tour',
    shortDescription: 'Delhi, Agra and Jaipur royal experience',
    description: 'Detailed description of the royal tour...',
    durationDays: 6,
    durationNights: 5,
    originCity: 'Delhi',
    destinationCity: 'Jaipur',
    baseAdultPrice: 5000000,
    baseChildPrice: 3000000,
    currency: 'INR' as SupportedCurrency,
    heroImageUrl: 'https://images.unsplash.com/hero.jpg',
    galleryUrls: [],
    inclusions: ['Luxury Hotel', 'Private Transport', 'Breakfast'],
    exclusions: ['Airfare', 'Personal Expenses'],
    accommodationTiers: ['STANDARD', 'LUXURY'],
    mealPlans: ['HALF_BOARD'],
    isPublished: true,
    isFeatured: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };

  const mockDestination: DestinationEntity = {
    id: sampleDestinationId,
    slug: 'rajasthan-jaipur',
    cityName: 'Jaipur',
    country: 'India',
    description: 'The Pink City',
    thumbnailUrl: 'https://images.unsplash.com/jaipur.jpg',
    heroImageUrl: null,
    isFeatured: true,
    isPublished: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };

  const mockItineraryDays: ItineraryDayEntity[] = [
    {
      id: 'it-1',
      packageId: samplePackageId,
      dayNumber: 1,
      title: 'Arrival in Delhi',
      activityDescription: 'Sightseeing in Old Delhi',
      mealsIncluded: ['BREAKFAST'],
      accommodationNotes: '5-star hotel in central Delhi',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    },
    {
      id: 'it-2',
      packageId: samplePackageId,
      dayNumber: 2,
      title: 'Drive to Agra',
      activityDescription: 'Taj Mahal at sunset',
      mealsIncluded: ['BREAKFAST', 'DINNER'],
      accommodationNotes: 'Taj View resort',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    },
  ];

  const mockHold: InventoryHoldEntity = {
    id: sampleHoldId,
    departureId: sampleDepartureId,
    checkoutSessionToken: 'session-token-1234',
    userId: sampleUserId,
    heldSeats: 2,
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    createdAt: new Date(),
  };

  const mockBooking: BookingEntity = {
    id: sampleBookingId,
    bookingReference: sampleBookingRef,
    customerId: sampleUserId,
    departureId: sampleDepartureId,
    holdId: sampleHoldId,
    partySize: 2,
    adultCount: 2,
    childCount: 0,
    totalPrice: 9600000,
    currency: 'INR',
    status: 'AWAITING_PAYMENT',
    priceBreakdown: {
      adultCount: 2,
      adultUnitPrice: 4800000,
      adultSubtotal: 9600000,
      childCount: 0,
      childUnitPrice: 2700000,
      childSubtotal: 0,
      baseSubtotal: 9600000,
      discountAmount: 0,
      totalPrice: 9600000,
      currency: 'INR',
      calculatedAt: '2026-09-26T00:00:00.000Z',
    },
    packageSnapshot: {
      packageId: samplePackageId,
      slug: 'golden-triangle-luxury',
      title: 'Golden Triangle Luxury Tour',
      shortDescription: 'Delhi, Agra and Jaipur royal experience',
      durationDays: 6,
      durationNights: 5,
      originCity: 'Delhi',
      destinationCity: 'Jaipur',
      destinationCountry: 'India',
      heroImageUrl: 'https://images.unsplash.com/hero.jpg',
      inclusions: ['Luxury Hotel', 'Private Transport'],
      exclusions: ['Airfare'],
      accommodationTier: 'DELUXE',
      mealPlan: 'MAP',
    },
    departureSnapshot: {
      departureId: sampleDepartureId,
      departureDate: '2026-11-15',
      returnDate: '2026-11-20',
      pricingApplied: {
        basePriceAdult: 4800000,
        basePriceChild: 2700000,
        singleSupplementPrice: null,
        currency: 'INR',
      },
      statusAtBooking: 'OPEN',
    },
    itinerarySnapshot: [
      {
        dayNumber: 1,
        title: 'Arrival in Delhi',
        activityDescription: 'Sightseeing in Old Delhi',
        mealsIncluded: ['BREAKFAST'],
        accommodationNotes: '5-star hotel in central Delhi',
      },
    ],
    primaryContact: {
      name: 'John Doe',
      email: 'john@example.com',
      phone: '+919876543210',
    },
    cancellationReason: null,
    cancelledAt: null,
    confirmedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const sampleCreateBookingDto: CreateBookingDto = {
    departureId: sampleDepartureId,
    partySize: 2,
    adultCount: 2,
    childCount: 0,
    primaryContact: {
      name: 'John Doe',
      email: 'john@example.com',
      phone: '+919876543210',
    },
    passengers: [
      {
        passengerType: 'ADULT',
        fullName: 'John Doe',
        dateOfBirth: '1990-05-15',
        ageAtBooking: 36,
        gender: 'MALE',
        isPrimaryContact: true,
        specialRequests: 'Vegetarian meal',
      },
      {
        passengerType: 'ADULT',
        fullName: 'Jane Doe',
        dateOfBirth: '1992-08-20',
        ageAtBooking: 34,
        gender: 'FEMALE',
        isPrimaryContact: false,
        specialRequests: null,
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      withTransaction: vi.fn(async (cb: (client: pg.PoolClient) => Promise<unknown>) =>
        cb({} as pg.PoolClient),
      ),
    } as unknown as DatabaseService;

    mockBookingRepo = {
      create: vi.fn().mockResolvedValue(mockBooking),
      findById: vi.fn().mockResolvedValue(mockBooking),
      findByReference: vi.fn().mockResolvedValue(mockBooking),
      findByReferenceAndCustomer: vi.fn().mockResolvedValue(mockBooking),
      findByCustomerId: vi
        .fn()
        .mockResolvedValue({ bookings: [], total: 0, page: 1, limit: 10, totalPages: 0 }),
      listAdmin: vi
        .fn()
        .mockResolvedValue({ bookings: [], total: 0, page: 1, limit: 10, totalPages: 0 }),
      updateStatusGuarded: vi.fn().mockResolvedValue(mockBooking),
      findDepartureManifest: vi.fn().mockResolvedValue(null),
    } as unknown as BookingRepository;

    mockPassengerRepo = {
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue([
        {
          id: 'pass-1',
          bookingId: sampleBookingId,
          passengerType: 'ADULT',
          fullName: 'John Doe',
          dateOfBirth: '1990-05-15',
          ageAtBooking: 36,
          gender: 'MALE',
          isPrimaryContact: true,
          specialRequests: 'Vegetarian meal',
          createdAt: new Date(),
        },
        {
          id: 'pass-2',
          bookingId: sampleBookingId,
          passengerType: 'ADULT',
          fullName: 'Jane Doe',
          dateOfBirth: '1992-08-20',
          ageAtBooking: 34,
          gender: 'FEMALE',
          isPrimaryContact: false,
          specialRequests: null,
          createdAt: new Date(),
        },
      ]),
      findByBookingId: vi.fn().mockResolvedValue([]),
    } as unknown as PassengerRepository;

    mockIdempotencyRepo = {
      find: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: 'idem-1',
        userId: sampleUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: 'key-1234',
        requestHash: 'hash-1234',
        responseCode: 201,
        responseBody: {},
        expiresAt: new Date(),
        createdAt: new Date(),
      }),
      deleteExpired: vi.fn().mockResolvedValue(0),
    } as unknown as IdempotencyRepository;

    mockDepartureRepo = {
      findById: vi.fn().mockResolvedValue(mockDeparture),
      findByIdForUpdate: vi.fn().mockResolvedValue(mockDeparture),
      incrementBookedSeats: vi.fn().mockResolvedValue(mockDeparture),
      decrementBookedSeats: vi.fn().mockResolvedValue(mockDeparture),
    } as unknown as DepartureRepository;

    mockInventoryHoldRepo = {
      create: vi.fn().mockResolvedValue(mockHold),
      findById: vi.fn().mockResolvedValue(mockHold),
      findByIdForUpdate: vi.fn().mockResolvedValue(mockHold),
      getActiveHoldCountForDeparture: vi.fn().mockResolvedValue(0),
      updateStatus: vi.fn().mockResolvedValue(mockHold),
      updateStatusGuarded: vi.fn().mockResolvedValue(mockHold),
      releaseHold: vi.fn().mockResolvedValue(true),
      findExpiredActiveHolds: vi.fn().mockResolvedValue([]),
    } as unknown as InventoryHoldRepository;

    mockPackageRepo = {
      findById: vi.fn().mockResolvedValue(mockPackage),
    } as unknown as TourPackageRepository;

    mockItineraryRepo = {
      listByPackageId: vi.fn().mockResolvedValue(mockItineraryDays),
    } as unknown as ItineraryRepository;

    mockDestinationRepo = {
      findById: vi.fn().mockResolvedValue(mockDestination),
    } as unknown as DestinationRepository;

    bookingService = new BookingService(
      mockDb,
      mockBookingRepo,
      mockPassengerRepo,
      mockIdempotencyRepo,
      mockDepartureRepo,
      mockInventoryHoldRepo,
      mockPackageRepo,
      mockItineraryRepo,
      mockDestinationRepo,
    );
  });

  describe('Booking Reference Generation', () => {
    it('generates references in canonical BK-YYYYMMDD-XXXX format', () => {
      const fixedDate = new Date('2026-11-15T10:00:00Z');
      const ref = bookingService.generateBookingReference(fixedDate);
      expect(ref).toMatch(/^BK-20261115-[0-9A-F]{4}$/);
    });

    it('generates distinct references on successive calls', () => {
      const ref1 = bookingService.generateBookingReference();
      const ref2 = bookingService.generateBookingReference();
      expect(ref1).not.toBe(ref2);
    });
  });

  describe('Booking Creation (createBooking)', () => {
    const defaultCommand: CreateBookingCommand = {
      userId: sampleUserId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey: 'idemp-key-001',
      requestHash: 'sha256-hash-001',
      bookingData: sampleCreateBookingDto,
    };

    it('creates a booking successfully within transaction and returns 15m hold', async () => {
      const result = await bookingService.createBooking(defaultCommand);

      expect(mockDb.withTransaction).toHaveBeenCalled();
      expect(mockDepartureRepo.findByIdForUpdate).toHaveBeenCalledWith(
        sampleDepartureId,
        expect.anything(),
      );
      expect(mockInventoryHoldRepo.getActiveHoldCountForDeparture).toHaveBeenCalledWith(
        sampleDepartureId,
        expect.anything(),
      );

      // Verify hold created with 15m expiry & ACTIVE status
      expect(mockInventoryHoldRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          departureId: sampleDepartureId,
          userId: sampleUserId,
          heldSeats: 2,
          status: 'ACTIVE',
        }),
        expect.anything(),
      );

      // Verify booking creation with calculated server pricing & snapshots
      expect(mockBookingRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: sampleUserId,
          departureId: sampleDepartureId,
          partySize: 2,
          adultCount: 2,
          childCount: 0,
          totalPrice: 9600000, // 2 * 48,000 (override price)
          currency: 'INR',
          status: 'AWAITING_PAYMENT',
          packageSnapshot: expect.objectContaining({
            packageId: samplePackageId,
            title: 'Golden Triangle Luxury Tour',
          }),
          departureSnapshot: expect.objectContaining({
            departureId: sampleDepartureId,
            departureDate: '2026-11-15',
          }),
        }),
        expect.anything(),
      );

      // Verify passenger bulk creation
      expect(mockPassengerRepo.createMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            fullName: 'John Doe',
            isPrimaryContact: true,
          }),
          expect.objectContaining({
            fullName: 'Jane Doe',
            isPrimaryContact: false,
          }),
        ]),
        expect.anything(),
      );

      // Verify idempotency record persistence
      expect(mockIdempotencyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: sampleUserId,
          endpointScope: 'POST:/api/v1/bookings',
          idempotencyKey: 'idemp-key-001',
          requestHash: 'sha256-hash-001',
          responseCode: 201,
        }),
        expect.anything(),
      );

      // Verify booked_seats was NOT incremented at booking creation
      expect(mockDepartureRepo.incrementBookedSeats).not.toHaveBeenCalled();

      expect(result.booking).toBeDefined();
      expect(result.passengers).toHaveLength(2);
      expect(result.hold).toBeDefined();
    });

    it('rejects booking when available capacity is less than requested party size', async () => {
      // 20 total, 15 booked, 4 held -> 1 available; requested: 2
      vi.mocked(mockDepartureRepo.findByIdForUpdate).mockResolvedValueOnce({
        ...mockDeparture,
        totalSeatCapacity: 20,
        bookedSeats: 15,
      });
      vi.mocked(mockInventoryHoldRepo.getActiveHoldCountForDeparture).mockResolvedValueOnce(4);

      await expect(bookingService.createBooking(defaultCommand)).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.INVENTORY_CAPACITY_EXCEEDED,
          statusCode: 400,
        }),
      );

      expect(mockInventoryHoldRepo.create).not.toHaveBeenCalled();
      expect(mockBookingRepo.create).not.toHaveBeenCalled();
    });

    it('rejects booking when departure is not OPEN', async () => {
      vi.mocked(mockDepartureRepo.findByIdForUpdate).mockResolvedValueOnce({
        ...mockDeparture,
        status: 'CLOSED' as DepartureStatus,
      });

      await expect(bookingService.createBooking(defaultCommand)).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.BOOKING_INVALID_STATE,
          statusCode: 400,
        }),
      );

      expect(mockInventoryHoldRepo.create).not.toHaveBeenCalled();
      expect(mockBookingRepo.create).not.toHaveBeenCalled();
    });

    it('replays cached response when idempotency key & hash match (idempotent replay)', async () => {
      const cachedPayload = {
        booking: { id: 'cached-b1', bookingReference: 'BK-CACHED-01' },
        passengers: [],
        hold: { id: 'cached-h1' },
      };

      vi.mocked(mockIdempotencyRepo.find).mockResolvedValueOnce({
        id: 'idem-1',
        userId: sampleUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: 'idemp-key-001',
        requestHash: 'sha256-hash-001',
        responseCode: 201,
        responseBody: cachedPayload,
        expiresAt: new Date(Date.now() + 10000),
        createdAt: new Date(),
      });

      const result = await bookingService.createBooking(defaultCommand);

      expect(result.isReplay).toBe(true);
      expect(result.booking.bookingReference).toBe('BK-CACHED-01');
      expect(mockDb.withTransaction).not.toHaveBeenCalled();
      expect(mockBookingRepo.create).not.toHaveBeenCalled();
    });

    it('throws IDEMPOTENCY_CONFLICT when key reused with different request hash', async () => {
      vi.mocked(mockIdempotencyRepo.find).mockResolvedValueOnce({
        id: 'idem-1',
        userId: sampleUserId,
        endpointScope: 'POST:/api/v1/bookings',
        idempotencyKey: 'idemp-key-001',
        requestHash: 'DIFFERENT-HASH-999',
        responseCode: 201,
        responseBody: {},
        expiresAt: new Date(Date.now() + 10000),
        createdAt: new Date(),
      });

      await expect(bookingService.createBooking(defaultCommand)).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.IDEMPOTENCY_CONFLICT,
          statusCode: 409,
        }),
      );

      expect(mockBookingRepo.create).not.toHaveBeenCalled();
    });

    it('calculates pricing correctly using base package prices when departure override is null', async () => {
      vi.mocked(mockDepartureRepo.findByIdForUpdate).mockResolvedValueOnce({
        ...mockDeparture,
        priceOverrideAdult: null,
        priceOverrideChild: null,
      });

      const commandWithChild: CreateBookingCommand = {
        ...defaultCommand,
        bookingData: {
          ...sampleCreateBookingDto,
          adultCount: 1,
          childCount: 1,
          partySize: 2,
        },
      };

      await bookingService.createBooking(commandWithChild);

      // Package base: adult 5,000,000 + child 3,000,000 = 8,000,000
      expect(mockBookingRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          totalPrice: 8000000,
          priceBreakdown: expect.objectContaining({
            adultUnitPrice: 5000000,
            childUnitPrice: 3000000,
            totalPrice: 8000000,
          }),
        }),
        expect.anything(),
      );
    });
  });

  describe('Booking Confirmation Primitive (confirmBooking)', () => {
    it('confirms booking, marks hold COMMITTED, and increments booked_seats strictly once', async () => {
      const confirmedBooking: BookingEntity = {
        ...mockBooking,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
      };
      vi.mocked(mockBookingRepo.updateStatusGuarded).mockResolvedValueOnce(confirmedBooking);

      const result = await bookingService.confirmBooking({
        bookingId: sampleBookingId,
        paymentVerified: true,
      });

      expect(mockBookingRepo.findById).toHaveBeenCalledWith(sampleBookingId, expect.anything());
      expect(mockInventoryHoldRepo.findById).toHaveBeenCalledWith(sampleHoldId, expect.anything());
      expect(mockBookingRepo.updateStatusGuarded).toHaveBeenCalledWith(
        sampleBookingId,
        'AWAITING_PAYMENT',
        'CONFIRMED',
        expect.objectContaining({ confirmedAt: expect.any(Date) }),
        expect.anything(),
      );
      expect(mockInventoryHoldRepo.updateStatusGuarded).toHaveBeenCalledWith(
        sampleHoldId,
        'ACTIVE',
        'COMMITTED',
        expect.anything(),
      );
      expect(mockDepartureRepo.incrementBookedSeats).toHaveBeenCalledWith(
        sampleDepartureId,
        2,
        expect.anything(),
      );
      expect(result.status).toBe('CONFIRMED');
    });

    it('returns idempotently if booking is already CONFIRMED without double incrementing seats', async () => {
      vi.mocked(mockBookingRepo.findById).mockResolvedValueOnce({
        ...mockBooking,
        status: 'CONFIRMED',
      });

      const result = await bookingService.confirmBooking({
        bookingId: sampleBookingId,
        paymentVerified: true,
      });

      expect(result.status).toBe('CONFIRMED');
      expect(mockBookingRepo.updateStatusGuarded).not.toHaveBeenCalled();
      expect(mockDepartureRepo.incrementBookedSeats).not.toHaveBeenCalled();
    });

    it('rejects confirmation if payment is not verified', async () => {
      await expect(
        bookingService.confirmBooking({
          bookingId: sampleBookingId,
          paymentVerified: false,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.BOOKING_INVALID_STATE,
          statusCode: 400,
        }),
      );

      expect(mockBookingRepo.updateStatusGuarded).not.toHaveBeenCalled();
    });

    it('rejects confirmation if associated inventory hold has EXPIRED (Late Payment Invariant)', async () => {
      vi.mocked(mockInventoryHoldRepo.findById).mockResolvedValueOnce({
        ...mockHold,
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - 60000), // Expired 1 min ago
      });

      await expect(
        bookingService.confirmBooking({
          bookingId: sampleBookingId,
          paymentVerified: true,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.INVENTORY_HOLD_EXPIRED,
          statusCode: 400,
        }),
      );

      expect(mockBookingRepo.updateStatusGuarded).not.toHaveBeenCalled();
      expect(mockDepartureRepo.incrementBookedSeats).not.toHaveBeenCalled();
    });

    it('rejects confirmation if booking is in EXPIRED state (Forbidden transition)', async () => {
      vi.mocked(mockBookingRepo.findById).mockResolvedValueOnce({
        ...mockBooking,
        status: 'EXPIRED',
      });

      await expect(
        bookingService.confirmBooking({
          bookingId: sampleBookingId,
          paymentVerified: true,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.BOOKING_INVALID_STATE,
          statusCode: 400,
        }),
      );

      expect(mockBookingRepo.updateStatusGuarded).not.toHaveBeenCalled();
    });
  });

  describe('Booking Cancellation (cancelBooking)', () => {
    it('cancels CONFIRMED booking and decrements booked_seats strictly once', async () => {
      vi.mocked(mockBookingRepo.findByReferenceAndCustomer).mockResolvedValueOnce({
        ...mockBooking,
        status: 'CONFIRMED',
      });

      const cancelledBooking: BookingEntity = {
        ...mockBooking,
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: 'Customer requested cancellation',
      };
      vi.mocked(mockBookingRepo.updateStatusGuarded).mockResolvedValueOnce(cancelledBooking);

      const result = await bookingService.cancelBooking({
        bookingReference: sampleBookingRef,
        customerId: sampleUserId,
        reason: 'Customer requested cancellation',
      });

      expect(mockBookingRepo.updateStatusGuarded).toHaveBeenCalledWith(
        sampleBookingId,
        'CONFIRMED',
        'CANCELLED',
        expect.objectContaining({
          cancellationReason: 'Customer requested cancellation',
          cancelledAt: expect.any(Date),
        }),
        expect.anything(),
      );

      // Single-decrement invariant verified
      expect(mockDepartureRepo.decrementBookedSeats).toHaveBeenCalledWith(
        sampleDepartureId,
        2,
        expect.anything(),
      );

      expect(result.status).toBe('CANCELLED');
    });

    it('rejects cancellation when departure has insufficient booked seats to decrement (invariant guard)', async () => {
      vi.mocked(mockBookingRepo.findByReferenceAndCustomer).mockResolvedValueOnce({
        ...mockBooking,
        status: 'CONFIRMED',
      });

      const cancelledBooking: BookingEntity = {
        ...mockBooking,
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: 'Customer requested cancellation',
      };
      vi.mocked(mockBookingRepo.updateStatusGuarded).mockResolvedValueOnce(cancelledBooking);

      // Simulate invariant violation where booked_seats < partySize
      vi.mocked(mockDepartureRepo.decrementBookedSeats).mockResolvedValueOnce(null);

      await expect(
        bookingService.cancelBooking({
          bookingReference: sampleBookingRef,
          customerId: sampleUserId,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.INVENTORY_CAPACITY_EXCEEDED,
          statusCode: 400,
        }),
      );
    });

    it('rejects cancellation of AWAITING_PAYMENT booking (only CONFIRMED bookings can be cancelled)', async () => {
      vi.mocked(mockBookingRepo.findByReferenceAndCustomer).mockResolvedValueOnce({
        ...mockBooking,
        status: 'AWAITING_PAYMENT',
      });

      await expect(
        bookingService.cancelBooking({
          bookingReference: sampleBookingRef,
          customerId: sampleUserId,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.BOOKING_INVALID_STATE,
          statusCode: 400,
        }),
      );

      expect(mockBookingRepo.updateStatusGuarded).not.toHaveBeenCalled();
      expect(mockDepartureRepo.decrementBookedSeats).not.toHaveBeenCalled();
    });

    it('rejects cancellation if booking is already CANCELLED with BOOKING_ALREADY_CANCELLED', async () => {
      vi.mocked(mockBookingRepo.findByReferenceAndCustomer).mockResolvedValueOnce({
        ...mockBooking,
        status: 'CANCELLED',
      });

      await expect(
        bookingService.cancelBooking({
          bookingReference: sampleBookingRef,
          customerId: sampleUserId,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.BOOKING_ALREADY_CANCELLED,
          statusCode: 400,
        }),
      );

      expect(mockDepartureRepo.decrementBookedSeats).not.toHaveBeenCalled();
    });

    it('rejects cancellation if booking is EXPIRED with BOOKING_INVALID_STATE', async () => {
      vi.mocked(mockBookingRepo.findByReferenceAndCustomer).mockResolvedValueOnce({
        ...mockBooking,
        status: 'EXPIRED',
      });

      await expect(
        bookingService.cancelBooking({
          bookingReference: sampleBookingRef,
          customerId: sampleUserId,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.BOOKING_INVALID_STATE,
          statusCode: 400,
        }),
      );

      expect(mockDepartureRepo.decrementBookedSeats).not.toHaveBeenCalled();
    });

    it('enforces customer ownership: throws BOOKING_NOT_FOUND when customer does not own booking', async () => {
      vi.mocked(mockBookingRepo.findByReferenceAndCustomer).mockResolvedValueOnce(null);

      await expect(
        bookingService.cancelBooking({
          bookingReference: sampleBookingRef,
          customerId: 'unauthorized-customer-id',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCodes.BOOKING_NOT_FOUND,
          statusCode: 404,
        }),
      );
    });
  });

  describe('Booking Expiry Primitive (expireBooking)', () => {
    it('expires an AWAITING_PAYMENT booking, marks hold EXPIRED, and does NOT decrement booked_seats', async () => {
      const expiredBooking: BookingEntity = {
        ...mockBooking,
        status: 'EXPIRED',
      };
      vi.mocked(mockBookingRepo.updateStatusGuarded).mockResolvedValueOnce(expiredBooking);

      const result = await bookingService.expireBooking({
        bookingId: sampleBookingId,
      });

      expect(mockDepartureRepo.findByIdForUpdate).toHaveBeenCalledWith(
        sampleDepartureId,
        expect.anything(),
      );
      expect(mockBookingRepo.updateStatusGuarded).toHaveBeenCalledWith(
        sampleBookingId,
        'AWAITING_PAYMENT',
        'EXPIRED',
        {},
        expect.anything(),
      );
      expect(mockInventoryHoldRepo.updateStatusGuarded).toHaveBeenCalledWith(
        sampleHoldId,
        'ACTIVE',
        'EXPIRED',
        expect.anything(),
      );
      expect(mockDepartureRepo.decrementBookedSeats).not.toHaveBeenCalled();
      expect(result.status).toBe('EXPIRED');
    });

    it('returns idempotently if booking is already EXPIRED', async () => {
      vi.mocked(mockBookingRepo.findById).mockResolvedValueOnce({
        ...mockBooking,
        status: 'EXPIRED',
      });

      const result = await bookingService.expireBooking({
        bookingId: sampleBookingId,
      });

      expect(result.status).toBe('EXPIRED');
      expect(mockBookingRepo.updateStatusGuarded).not.toHaveBeenCalled();
    });
  });

  describe('Booking Lookups & Manifest Operations', () => {
    it('retrieves booking details with customer isolation', async () => {
      vi.mocked(mockPassengerRepo.findByBookingId).mockResolvedValueOnce([
        {
          id: 'pass-1',
          bookingId: sampleBookingId,
          passengerType: 'ADULT',
          fullName: 'John Doe',
          dateOfBirth: '1990-05-15',
          ageAtBooking: 36,
          gender: 'MALE',
          isPrimaryContact: true,
          specialRequests: null,
          createdAt: new Date(),
        },
      ]);

      const result = await bookingService.getBookingByReference(sampleBookingRef, sampleUserId);

      expect(mockBookingRepo.findByReferenceAndCustomer).toHaveBeenCalledWith(
        sampleBookingRef,
        sampleUserId,
      );
      expect(result.booking.id).toBe(sampleBookingId);
      expect(result.passengers).toHaveLength(1);
    });

    it('delegates customer bookings list query to repository', async () => {
      await bookingService.getCustomerBookings(sampleUserId, { page: 1, limit: 10 });
      expect(mockBookingRepo.findByCustomerId).toHaveBeenCalledWith(sampleUserId, {
        page: 1,
        limit: 10,
      });
    });

    it('delegates admin departure manifest query to repository', async () => {
      await bookingService.getDepartureManifest(sampleDepartureId);
      expect(mockBookingRepo.findDepartureManifest).toHaveBeenCalledWith(sampleDepartureId);
    });
  });
});
