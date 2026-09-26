import { describe, it, expect } from 'vitest';
import {
  BOOKING_STATUSES,
  PASSENGER_TYPES,
  PASSENGER_GENDERS,
  bookingStatusSchema,
  passengerTypeSchema,
  passengerGenderSchema,
  primaryContactSchema,
  createPassengerSchema,
  createBookingSchema,
  cancelBookingSchema,
  bookingListQuerySchema,
  adminBookingListQuerySchema,
  idempotencyHeaderSchema,
  priceBreakdownSnapshotSchema,
  packageSnapshotSchema,
  departureSnapshotSchema,
  itinerarySnapshotSchema,
  ErrorCodes,
  CreateBookingDto,
  BookingSummaryDto,
  BookingDetailsDto,
} from '../../shared/src/index.js';

describe('Shared Booking Contracts & Zod Validation Schemas (Phase 5 Step 2)', () => {
  // ============================================================
  // 1. Enum & Type Classification Integrity
  // ============================================================
  describe('1. Controlled Enums & Taxonomies', () => {
    it('1.1 BookingStatus matches canonical Phase 5 states strictly', () => {
      expect(BOOKING_STATUSES).toEqual(['AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED']);

      for (const status of BOOKING_STATUSES) {
        expect(bookingStatusSchema.safeParse(status).success).toBe(true);
      }

      // Rejects invalid states
      expect(bookingStatusSchema.safeParse('PENDING').success).toBe(false);
      expect(bookingStatusSchema.safeParse('PAID').success).toBe(false);
      expect(bookingStatusSchema.safeParse('COMPLETED').success).toBe(false);
    });

    it('1.2 PassengerType matches canonical values (ADULT, CHILD)', () => {
      expect(PASSENGER_TYPES).toEqual(['ADULT', 'CHILD']);
      expect(passengerTypeSchema.safeParse('ADULT').success).toBe(true);
      expect(passengerTypeSchema.safeParse('CHILD').success).toBe(true);
      expect(passengerTypeSchema.safeParse('INFANT').success).toBe(false);
    });

    it('1.3 PassengerGender matches database enum values', () => {
      expect(PASSENGER_GENDERS).toEqual(['MALE', 'FEMALE', 'OTHER']);
      expect(passengerGenderSchema.safeParse('MALE').success).toBe(true);
      expect(passengerGenderSchema.safeParse('FEMALE').success).toBe(true);
      expect(passengerGenderSchema.safeParse('OTHER').success).toBe(true);
      expect(passengerGenderSchema.safeParse('UNKNOWN').success).toBe(false);
    });

    it('1.4 ErrorCodes includes all canonical Phase 5 error codes', () => {
      expect(ErrorCodes.BOOKING_NOT_FOUND).toBe('BOOKING_NOT_FOUND');
      expect(ErrorCodes.BOOKING_ALREADY_CANCELLED).toBe('BOOKING_ALREADY_CANCELLED');
      expect(ErrorCodes.BOOKING_INVALID_STATE).toBe('BOOKING_INVALID_STATE');
      expect(ErrorCodes.HOLD_NOT_FOUND).toBe('HOLD_NOT_FOUND');
      expect(ErrorCodes.IDEMPOTENCY_CONFLICT).toBe('IDEMPOTENCY_CONFLICT');
      expect(ErrorCodes.INVENTORY_HOLD_EXPIRED).toBe('INVENTORY_HOLD_EXPIRED');
    });
  });

  // ============================================================
  // 2. Primary Contact & Passenger Validation
  // ============================================================
  describe('2. Primary Contact & Passenger Validation Schemas', () => {
    const validContact = {
      name: 'Jane Doe',
      email: 'jane.doe@example.com',
      phone: '+91 98765 43210',
    };

    it('2.1 passes with valid primary contact details and normalizes email', () => {
      const result = primaryContactSchema.safeParse({
        ...validContact,
        email: '  JANE.DOE@EXAMPLE.COM  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('jane.doe@example.com');
        expect(result.data.name).toBe('Jane Doe');
      }
    });

    it('2.2 rejects invalid primary contact email or phone format', () => {
      expect(
        primaryContactSchema.safeParse({ ...validContact, email: 'not-an-email' }).success,
      ).toBe(false);
      expect(primaryContactSchema.safeParse({ ...validContact, phone: '123' }).success).toBe(false);
      expect(primaryContactSchema.safeParse({ ...validContact, name: 'A' }).success).toBe(false);
    });

    it('2.3 validates passenger records with age_at_booking and optional DOB', () => {
      const validAdult = {
        passengerType: 'ADULT' as const,
        fullName: 'Jane Doe',
        dateOfBirth: '1990-05-15',
        ageAtBooking: 36,
        gender: 'FEMALE' as const,
        isPrimaryContact: true,
        specialRequests: 'Window seat preference',
      };

      const result = createPassengerSchema.safeParse(validAdult);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ageAtBooking).toBe(36);
        expect(result.data.dateOfBirth).toBe('1990-05-15');
        expect(result.data.isPrimaryContact).toBe(true);
      }
    });

    it('2.4 rejects invalid passenger age (< 0 or > 120)', () => {
      const base = {
        passengerType: 'ADULT' as const,
        fullName: 'Test Person',
        ageAtBooking: -1,
        gender: 'OTHER' as const,
      };

      expect(createPassengerSchema.safeParse(base).success).toBe(false);
      expect(createPassengerSchema.safeParse({ ...base, ageAtBooking: 125 }).success).toBe(false);
      expect(createPassengerSchema.safeParse({ ...base, ageAtBooking: 25.5 }).success).toBe(false);
    });

    it('2.5 rejects malformed DOB format on passenger', () => {
      const base = {
        passengerType: 'CHILD' as const,
        fullName: 'Young Person',
        dateOfBirth: '15/05/2018',
        ageAtBooking: 8,
        gender: 'MALE' as const,
      };

      expect(createPassengerSchema.safeParse(base).success).toBe(false);
    });
  });

  // ============================================================
  // 3. CreateBookingSchema Validation
  // ============================================================
  describe('3. CreateBookingSchema Validation', () => {
    const validBookingPayload = {
      departureId: '11111111-2222-3333-4444-555555555555',
      partySize: 2,
      adultCount: 1,
      childCount: 1,
      primaryContact: {
        name: 'Jane Doe',
        email: 'jane@example.com',
        phone: '+919876543210',
      },
      passengers: [
        {
          passengerType: 'ADULT' as const,
          fullName: 'Jane Doe',
          ageAtBooking: 34,
          gender: 'FEMALE' as const,
          isPrimaryContact: true,
        },
        {
          passengerType: 'CHILD' as const,
          fullName: 'Tommy Doe',
          ageAtBooking: 7,
          gender: 'MALE' as const,
          isPrimaryContact: false,
        },
      ],
    };

    it('3.1 passes with valid booking payload and enforces cross-field party invariants', () => {
      const result = createBookingSchema.safeParse(validBookingPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.departureId).toBe('11111111-2222-3333-4444-555555555555');
        expect(result.data.partySize).toBe(2);
        expect(result.data.passengers).toHaveLength(2);
      }
    });

    it('3.2 rejects partySize = 0 or negative counts', () => {
      expect(
        createBookingSchema.safeParse({
          ...validBookingPayload,
          partySize: 0,
          adultCount: 0,
          childCount: 0,
          passengers: [],
        }).success,
      ).toBe(false);
    });

    it('3.3 rejects partySize inconsistent with adultCount + childCount', () => {
      const result = createBookingSchema.safeParse({
        ...validBookingPayload,
        partySize: 3, // Inconsistent with 1 adult + 1 child = 2
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /Party size must equal the sum of adult count and child count/i,
        );
      }
    });

    it('3.4 rejects passengers array length mismatch with partySize', () => {
      const result = createBookingSchema.safeParse({
        ...validBookingPayload,
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        passengers: [validBookingPayload.passengers[0]], // Only 1 passenger provided
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /Number of passenger records must match party size/i,
        );
      }
    });

    it('3.5 rejects mismatch between passenger types in roster and adultCount/childCount', () => {
      const result = createBookingSchema.safeParse({
        ...validBookingPayload,
        partySize: 2,
        adultCount: 2, // Declared 2 adults
        childCount: 0,
        passengers: validBookingPayload.passengers, // Contains 1 adult, 1 child
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(
          /Number of adult passengers must match adultCount/i,
        );
      }
    });

    it('3.6 strictly rejects client-controlled server fields (totalPrice, status, bookingReference)', () => {
      const attackPayload = {
        ...validBookingPayload,
        totalPrice: 100, // Price manipulation attempt
        status: 'CONFIRMED', // Unauthorized status leap
        bookingReference: 'BK-HACK-001',
      };

      const result = createBookingSchema.safeParse(attackPayload);
      expect(result.success).toBe(false);
    });

    it('3.7 rejects non-UUID departureId', () => {
      expect(
        createBookingSchema.safeParse({
          ...validBookingPayload,
          departureId: 'not-a-uuid',
        }).success,
      ).toBe(false);
    });
  });

  // ============================================================
  // 4. Cancellation & Idempotency Schemas
  // ============================================================
  describe('4. Cancellation & Idempotency Schemas', () => {
    it('4.1 validates cancellation request schema', () => {
      expect(cancelBookingSchema.safeParse({ reason: 'Flight cancelled' }).success).toBe(true);
      expect(cancelBookingSchema.safeParse({}).success).toBe(true);
      expect(cancelBookingSchema.safeParse({ reason: null }).success).toBe(true);
      expect(cancelBookingSchema.safeParse({ reason: 'a'.repeat(501) }).success).toBe(false);
    });

    it('4.2 validates Idempotency-Key header schema', () => {
      expect(
        idempotencyHeaderSchema.safeParse({ 'idempotency-key': 'idem-uuid-12345' }).success,
      ).toBe(true);
      expect(idempotencyHeaderSchema.safeParse({ 'idempotency-key': '' }).success).toBe(false);
      expect(
        idempotencyHeaderSchema.safeParse({ 'idempotency-key': 'k'.repeat(129) }).success,
      ).toBe(false);
    });

    it('4.3 validates customer booking list pagination and status query schema', () => {
      const result = bookingListQuerySchema.safeParse({
        page: '2',
        limit: '20',
        status: 'CONFIRMED',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(2);
        expect(result.data.limit).toBe(20);
        expect(result.data.status).toBe('CONFIRMED');
      }

      // Default values
      const defaultRes = bookingListQuerySchema.safeParse({});
      expect(defaultRes.data?.page).toBe(1);
      expect(defaultRes.data?.limit).toBe(10);
    });

    it('4.4 validates admin booking list query schema with filters', () => {
      const result = adminBookingListQuerySchema.safeParse({
        page: '1',
        limit: '25',
        departureId: '11111111-2222-3333-4444-555555555555',
        search: 'Jane',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.departureId).toBe('11111111-2222-3333-4444-555555555555');
        expect(result.data.search).toBe('Jane');
      }
    });
  });

  // ============================================================
  // 5. Immutable Historical Snapshots
  // ============================================================
  describe('5. Immutable Historical Snapshot Schemas', () => {
    it('5.1 validates price breakdown snapshot schema', () => {
      const priceSnapshot = {
        adultCount: 2,
        adultUnitPrice: 4500000,
        adultSubtotal: 9000000,
        childCount: 1,
        childUnitPrice: 2250000,
        childSubtotal: 2250000,
        baseSubtotal: 11250000,
        discountAmount: 0,
        totalPrice: 11250000,
        currency: 'INR' as const,
        calculatedAt: '2026-09-26T05:45:00.000Z',
      };

      expect(priceBreakdownSnapshotSchema.safeParse(priceSnapshot).success).toBe(true);
    });

    it('5.2 validates package snapshot schema', () => {
      const pkgSnapshot = {
        packageId: '11111111-1111-1111-1111-111111111111',
        slug: 'kashmir-delight',
        title: 'Kashmir Delight Tour',
        shortDescription: '6 Days paradise tour',
        durationDays: 6,
        durationNights: 5,
        originCity: 'Delhi',
        destinationCity: 'Srinagar',
        destinationCountry: 'India',
        heroImageUrl: 'https://images.example.com/kashmir.jpg',
        inclusions: ['Houseboat', 'Breakfast'],
        exclusions: ['Airfare'],
        accommodationTier: 'STANDARD',
        mealPlan: 'FULL_BOARD',
      };

      expect(packageSnapshotSchema.safeParse(pkgSnapshot).success).toBe(true);
    });

    it('5.3 validates departure snapshot schema', () => {
      const depSnapshot = {
        departureId: '22222222-2222-2222-2222-222222222222',
        departureDate: '2026-11-15',
        returnDate: '2026-11-20',
        pricingApplied: {
          basePriceAdult: 4500000,
          basePriceChild: 2250000,
          singleSupplementPrice: 0,
          currency: 'INR' as const,
        },
        statusAtBooking: 'OPEN',
      };

      expect(departureSnapshotSchema.safeParse(depSnapshot).success).toBe(true);
    });

    it('5.4 validates itinerary snapshot schema', () => {
      const itinSnapshot = [
        {
          dayNumber: 1,
          title: 'Arrival in Srinagar',
          activityDescription: 'Airport transfer & Dal Lake Shikara ride.',
          mealsIncluded: ['DINNER'],
          accommodationNotes: 'Houseboat',
        },
        {
          dayNumber: 2,
          title: 'Gulmarg Day Trip',
          activityDescription: 'Gondola ride and snow activities.',
          mealsIncluded: ['BREAKFAST', 'DINNER'],
          accommodationNotes: 'Houseboat',
        },
      ];

      expect(itinerarySnapshotSchema.safeParse(itinSnapshot).success).toBe(true);
    });
  });

  // ============================================================
  // 6. DTO Shape Invariant Check
  // ============================================================
  describe('6. DTO Types & Structure Integrity', () => {
    it('6.1 BookingSummaryDto represents compact booking card', () => {
      const summary: BookingSummaryDto = {
        id: '11111111-2222-3333-4444-555555555555',
        bookingReference: 'BK-20261115-A8F2',
        customerId: '22222222-3333-4444-5555-666666666666',
        departureId: '33333333-4444-5555-6666-777777777777',
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        totalPrice: 9000000,
        currency: 'INR',
        status: 'AWAITING_PAYMENT',
        primaryContact: {
          name: 'Jane Doe',
          email: 'jane@example.com',
          phone: '+919876543210',
        },
        packageTitle: 'Kashmir Tour',
        departureDate: '2026-11-15',
        returnDate: '2026-11-20',
        createdAt: '2026-09-26T06:00:00.000Z',
      };

      expect(summary.bookingReference).toBe('BK-20261115-A8F2');
      expect(summary.status).toBe('AWAITING_PAYMENT');
      expect(summary.totalPrice).toBe(9000000);
    });

    it('6.2 BookingDetailsDto contains snapshots and full passenger roster', () => {
      const details: BookingDetailsDto = {
        id: '11111111-2222-3333-4444-555555555555',
        bookingReference: 'BK-20261115-A8F2',
        customerId: '22222222-3333-4444-5555-666666666666',
        departureId: '33333333-4444-5555-6666-777777777777',
        partySize: 1,
        adultCount: 1,
        childCount: 0,
        totalPrice: 4500000,
        currency: 'INR',
        status: 'CONFIRMED',
        primaryContact: {
          name: 'Jane Doe',
          email: 'jane@example.com',
          phone: '+919876543210',
        },
        packageTitle: 'Kashmir Tour',
        departureDate: '2026-11-15',
        returnDate: '2026-11-20',
        createdAt: '2026-09-26T06:00:00.000Z',
        updatedAt: '2026-09-26T06:05:00.000Z',
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Jane Doe',
            ageAtBooking: 30,
            gender: 'FEMALE',
            isPrimaryContact: true,
          },
        ],
        priceBreakdown: {
          adultCount: 1,
          adultUnitPrice: 4500000,
          adultSubtotal: 4500000,
          childCount: 0,
          childUnitPrice: 0,
          childSubtotal: 0,
          baseSubtotal: 4500000,
          discountAmount: 0,
          totalPrice: 4500000,
          currency: 'INR',
          calculatedAt: '2026-09-26T06:00:00.000Z',
        },
        packageSnapshot: {
          packageId: '11111111-1111-1111-1111-111111111111',
          slug: 'kashmir-tour',
          title: 'Kashmir Tour',
          shortDescription: 'Short desc',
          durationDays: 6,
          durationNights: 5,
          originCity: 'Delhi',
          destinationCity: 'Srinagar',
          destinationCountry: 'India',
          heroImageUrl: 'https://images.example.com/img.jpg',
          inclusions: [],
          exclusions: [],
        },
        departureSnapshot: {
          departureId: '33333333-4444-5555-6666-777777777777',
          departureDate: '2026-11-15',
          returnDate: '2026-11-20',
          pricingApplied: {
            basePriceAdult: 4500000,
            basePriceChild: 2250000,
            currency: 'INR',
          },
          statusAtBooking: 'OPEN',
        },
        itinerarySnapshot: [],
      };

      expect(details.passengers).toHaveLength(1);
      expect(details.packageSnapshot.title).toBe('Kashmir Tour');
      expect(details.departureSnapshot.departureDate).toBe('2026-11-15');
    });

    it('6.3 CreateBookingDto correctly models booking initiation request payload', () => {
      const createPayload: CreateBookingDto = {
        departureId: '11111111-2222-3333-4444-555555555555',
        partySize: 2,
        adultCount: 2,
        childCount: 0,
        passengers: [
          {
            passengerType: 'ADULT',
            fullName: 'Jane Doe',
            ageAtBooking: 30,
            gender: 'FEMALE',
            isPrimaryContact: true,
          },
          {
            passengerType: 'ADULT',
            fullName: 'John Doe',
            ageAtBooking: 32,
            gender: 'MALE',
            isPrimaryContact: false,
          },
        ],
        primaryContact: {
          name: 'Jane Doe',
          email: 'jane@example.com',
          phone: '+919876543210',
        },
      };

      expect(createPayload.partySize).toBe(2);
      expect(createPayload.passengers).toHaveLength(2);
    });
  });
});
