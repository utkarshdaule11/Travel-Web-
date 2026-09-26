import crypto from 'crypto';
import type pg from 'pg';
import { DatabaseService } from '../../../infrastructure/database/index.js';
import {
  AppError,
  CreateBookingDto,
  DepartureSnapshot,
  ErrorCodes,
  ItinerarySnapshot,
  PackageSnapshot,
  PassengerDto,
  PriceBreakdownSnapshot,
  SupportedCurrency,
} from '../../../../../shared/src/index.js';
import {
  AdminBookingListOptions,
  AdminBookingListResult,
  BookingEntity,
  BookingListOptions,
  BookingListResult,
  BookingRepository,
  DepartureManifestEntity,
} from '../repositories/booking.repository.js';
import { PassengerRepository } from '../repositories/passenger.repository.js';
import { IdempotencyRepository } from '../repositories/idempotency.repository.js';
import { DepartureRepository } from '../../inventory/repositories/departure.repository.js';
import {
  InventoryHoldEntity,
  InventoryHoldRepository,
} from '../../inventory/repositories/inventoryHold.repository.js';
import { TourPackageRepository } from '../../catalogue/repositories/tourPackage.repository.js';
import { ItineraryRepository } from '../../catalogue/repositories/itinerary.repository.js';
import { DestinationRepository } from '../../catalogue/repositories/destination.repository.js';
import { assertBookingTransition } from '../domain/bookingStateMachine.js';

// ============================================================
// Command & Result Interfaces
// ============================================================

export interface CreateBookingCommand {
  userId: string;
  endpointScope: string;
  idempotencyKey: string;
  requestHash: string;
  bookingData: CreateBookingDto;
}

export interface BookingCreationResult {
  booking: BookingEntity;
  passengers: PassengerDto[];
  hold: InventoryHoldEntity;
  isReplay?: boolean;
}

export interface ConfirmBookingCommand {
  bookingId: string;
  paymentVerified: boolean;
}

export interface CancelBookingCommand {
  bookingReference: string;
  customerId?: string;
  isAdmin?: boolean;
  reason?: string;
}

export interface ExpireBookingCommand {
  bookingId: string;
}

export interface BookingDetailsResult {
  booking: BookingEntity;
  passengers: PassengerDto[];
  holdExpiresAt?: string | null;
}

// ============================================================
// BookingService Implementation
// ============================================================

export class BookingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly bookingRepo: BookingRepository,
    private readonly passengerRepo: PassengerRepository,
    private readonly idempotencyRepo: IdempotencyRepository,
    private readonly departureRepo: DepartureRepository,
    private readonly inventoryHoldRepo: InventoryHoldRepository,
    private readonly packageRepo: TourPackageRepository,
    private readonly itineraryRepo: ItineraryRepository,
    private readonly destinationRepo: DestinationRepository,
  ) {}

  /**
   * Helper: Generate a collision-resistant booking reference: BK-YYYYMMDD-XXXX.
   */
  public generateBookingReference(date: Date = new Date()): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const datePart = `${yyyy}${mm}${dd}`;

    const randomPart = crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase();

    return `BK-${datePart}-${randomPart}`;
  }

  /**
   * Orchestrate booking creation within a single atomic PostgreSQL transaction.
   *
   * Flow:
   * 1. Idempotency verification / replay check.
   * 2. Transaction BEGIN.
   * 3. Row-level lock on departure schedule (`FOR UPDATE`).
   * 4. Dynamic seat availability check (`S_available = total - booked - activeHolds`).
   * 5. Snapshot construction (package, departure, itinerary, price breakdown).
   * 6. 15-minute ACTIVE inventory hold creation.
   * 7. Booking record insertion (`AWAITING_PAYMENT`).
   * 8. Bulk passenger roster insertion.
   * 9. Idempotency persistence.
   * 10. Transaction COMMIT.
   */
  async createBooking(command: CreateBookingCommand): Promise<BookingCreationResult> {
    const { userId, endpointScope, idempotencyKey, requestHash, bookingData } = command;

    // 1. Initial Idempotency Check (pre-flight cache hit)
    const existingIdempotency = await this.idempotencyRepo.find(
      userId,
      endpointScope,
      idempotencyKey,
    );

    if (existingIdempotency) {
      if (existingIdempotency.requestHash === requestHash) {
        const payload =
          typeof existingIdempotency.responseBody === 'string'
            ? JSON.parse(existingIdempotency.responseBody)
            : existingIdempotency.responseBody;
        return {
          ...payload,
          isReplay: true,
        };
      } else {
        throw AppError.conflict(
          'Idempotency key reused with different request parameters',
          ErrorCodes.IDEMPOTENCY_CONFLICT,
        );
      }
    }

    // 2. Transactional Booking Creation Flow
    return this.db.withTransaction(async (client: pg.PoolClient) => {
      // 2.1 Double-check idempotency key within transaction lock boundary
      const txIdempotency = await this.idempotencyRepo.find(
        userId,
        endpointScope,
        idempotencyKey,
        client,
      );

      if (txIdempotency) {
        if (txIdempotency.requestHash === requestHash) {
          const payload =
            typeof txIdempotency.responseBody === 'string'
              ? JSON.parse(txIdempotency.responseBody)
              : txIdempotency.responseBody;
          return {
            ...payload,
            isReplay: true,
          };
        } else {
          throw AppError.conflict(
            'Idempotency key reused with different request parameters',
            ErrorCodes.IDEMPOTENCY_CONFLICT,
          );
        }
      }

      // 2.2 Acquire exclusive row lock on departure schedule
      const departure = await this.departureRepo.findByIdForUpdate(bookingData.departureId, client);
      if (!departure) {
        throw AppError.notFound('Departure schedule not found', ErrorCodes.RESOURCE_NOT_FOUND);
      }

      if (departure.status !== 'OPEN') {
        throw AppError.badRequest(
          `Departure schedule is not open for booking (current status: ${departure.status})`,
          [{ field: 'departureId', issue: 'Departure is not open for bookings' }],
          ErrorCodes.BOOKING_INVALID_STATE,
        );
      }

      // 2.3 Compute authoritative live availability
      const activeHeldSeats = await this.inventoryHoldRepo.getActiveHoldCountForDeparture(
        departure.id,
        client,
      );
      const availableSeats = Math.max(
        0,
        departure.totalSeatCapacity - departure.bookedSeats - activeHeldSeats,
      );

      if (availableSeats < bookingData.partySize) {
        throw AppError.badRequest(
          `Insufficient available seats on departure (${availableSeats} available, ${bookingData.partySize} requested)`,
          [{ field: 'partySize', issue: 'Requested party size exceeds available seats' }],
          ErrorCodes.INVENTORY_CAPACITY_EXCEEDED,
        );
      }

      // 2.4 Fetch package, destination and itinerary for snapshot generation
      const pkg = await this.packageRepo.findById(departure.packageId, client);
      if (!pkg) {
        throw AppError.notFound('Tour package not found', ErrorCodes.RESOURCE_NOT_FOUND);
      }

      const destination = await this.destinationRepo.findById(pkg.destinationId, client);
      const itineraryDays = await this.itineraryRepo.listByPackageId(pkg.id, client);

      // 2.5 Server-Side Price Calculation (Integer Minor Units)
      const adultUnitPrice =
        departure.priceOverrideAdult !== null && departure.priceOverrideAdult !== undefined
          ? departure.priceOverrideAdult
          : pkg.baseAdultPrice;

      const childUnitPrice =
        departure.priceOverrideChild !== null && departure.priceOverrideChild !== undefined
          ? departure.priceOverrideChild
          : (pkg.baseChildPrice ?? pkg.baseAdultPrice);

      const currency: SupportedCurrency = departure.currency ?? pkg.currency;

      const adultSubtotal = bookingData.adultCount * adultUnitPrice;
      const childSubtotal = bookingData.childCount * childUnitPrice;
      const baseSubtotal = adultSubtotal + childSubtotal;
      const discountAmount = 0; // No discount coupons in current scope
      const totalPrice = baseSubtotal - discountAmount;

      const priceBreakdown: PriceBreakdownSnapshot = {
        adultCount: bookingData.adultCount,
        adultUnitPrice,
        adultSubtotal,
        childCount: bookingData.childCount,
        childUnitPrice,
        childSubtotal,
        baseSubtotal,
        discountAmount,
        totalPrice,
        currency,
        calculatedAt: new Date().toISOString(),
      };

      // 2.6 Immutable Snapshot Construction
      const packageSnapshot: PackageSnapshot = {
        packageId: pkg.id,
        slug: pkg.slug,
        title: pkg.title,
        shortDescription: pkg.shortDescription,
        durationDays: pkg.durationDays,
        durationNights: pkg.durationNights,
        originCity: pkg.originCity,
        destinationCity: pkg.destinationCity,
        destinationCountry: destination?.country ?? 'India',
        heroImageUrl: pkg.heroImageUrl,
        inclusions: pkg.inclusions,
        exclusions: pkg.exclusions,
        accommodationTier: pkg.accommodationTiers?.[0] ?? null,
        mealPlan: pkg.mealPlans?.[0] ?? null,
      };

      const departureSnapshot: DepartureSnapshot = {
        departureId: departure.id,
        departureDate: departure.departureDate,
        returnDate: departure.returnDate,
        pricingApplied: {
          basePriceAdult: adultUnitPrice,
          basePriceChild: childUnitPrice,
          singleSupplementPrice: null,
          currency,
        },
        statusAtBooking: departure.status,
      };

      const itinerarySnapshot: ItinerarySnapshot = itineraryDays.map((day) => ({
        dayNumber: day.dayNumber,
        title: day.title,
        activityDescription: day.activityDescription,
        mealsIncluded: day.mealsIncluded ?? [],
        accommodationNotes: day.accommodationNotes ?? null,
      }));

      // 2.7 Create 15-Minute ACTIVE Inventory Hold
      const checkoutSessionToken = crypto.randomUUID();
      const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // Exactly 15 minutes

      const hold = await this.inventoryHoldRepo.create(
        {
          departureId: departure.id,
          checkoutSessionToken,
          userId,
          heldSeats: bookingData.partySize,
          status: 'ACTIVE',
          expiresAt: holdExpiresAt,
        },
        client,
      );

      // 2.8 Generate Unique Booking Reference
      const bookingReference = this.generateBookingReference();

      // 2.9 Persist Booking Entity in AWAITING_PAYMENT status
      const booking = await this.bookingRepo.create(
        {
          bookingReference,
          customerId: userId,
          departureId: departure.id,
          holdId: hold.id,
          partySize: bookingData.partySize,
          adultCount: bookingData.adultCount,
          childCount: bookingData.childCount,
          totalPrice,
          currency,
          status: 'AWAITING_PAYMENT',
          priceBreakdown,
          packageSnapshot,
          departureSnapshot,
          itinerarySnapshot,
          primaryContact: bookingData.primaryContact,
        },
        client,
      );

      // 2.10 Bulk Persist Passenger Roster
      const passengerEntities = await this.passengerRepo.createMany(
        bookingData.passengers.map((p) => ({
          bookingId: booking.id,
          passengerType: p.passengerType,
          fullName: p.fullName,
          dateOfBirth: p.dateOfBirth ?? null,
          ageAtBooking: p.ageAtBooking,
          gender: p.gender,
          isPrimaryContact: p.isPrimaryContact ?? false,
          specialRequests: p.specialRequests ?? null,
        })),
        client,
      );

      const passengers: PassengerDto[] = passengerEntities.map((p) => ({
        id: p.id,
        passengerType: p.passengerType,
        fullName: p.fullName,
        dateOfBirth: p.dateOfBirth,
        ageAtBooking: p.ageAtBooking,
        gender: p.gender,
        isPrimaryContact: p.isPrimaryContact,
        specialRequests: p.specialRequests,
        createdAt: p.createdAt.toISOString(),
      }));

      // 2.11 Persist Idempotency Record (24-hour TTL)
      const responsePayload = {
        booking,
        passengers,
        hold,
      };

      await this.idempotencyRepo.create(
        {
          userId,
          endpointScope,
          idempotencyKey,
          requestHash,
          responseCode: 201,
          responseBody: responsePayload,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        client,
      );

      return responsePayload;
    });
  }

  /**
   * Domain primitive to confirm a booking upon verified payment capture (Phase 6 hook).
   *
   * Invariants & Pessimistic Concurrency:
   * - Acquires departure row lock (`SELECT ... FOR UPDATE`) to preserve consistent lock ordering (`departure_schedules -> bookings -> inventory_holds`).
   * - Booking must be in `AWAITING_PAYMENT` state.
   * - Associated inventory hold must be strictly `ACTIVE` and `expiresAt > NOW()`.
   * - Atomic guarded update: `bookings` (AWAITING_PAYMENT -> CONFIRMED).
   * - Atomic guarded update: `inventory_holds` (ACTIVE -> COMMITTED).
   * - Increments `departure_schedules.booked_seats` by `partySize` exactly once.
   */
  async confirmBooking(command: ConfirmBookingCommand): Promise<BookingEntity> {
    if (!command.paymentVerified) {
      throw AppError.badRequest(
        'Payment verification required to confirm booking',
        [{ field: 'paymentVerified', issue: 'Payment must be verified' }],
        ErrorCodes.BOOKING_INVALID_STATE,
      );
    }

    return this.db.withTransaction(async (client: pg.PoolClient) => {
      const booking = await this.bookingRepo.findById(command.bookingId, client);
      if (!booking) {
        throw AppError.notFound('Booking not found', ErrorCodes.BOOKING_NOT_FOUND);
      }

      // Idempotent return if already confirmed
      if (booking.status === 'CONFIRMED') {
        return booking;
      }

      // Validate lifecycle state transition
      assertBookingTransition(booking.status, 'CONFIRMED');

      // Acquire departure row lock first for consistent lock order: departure_schedules -> bookings -> inventory_holds
      const departure = await this.departureRepo.findByIdForUpdate(booking.departureId, client);
      if (!departure) {
        throw AppError.notFound('Departure schedule not found', ErrorCodes.RESOURCE_NOT_FOUND);
      }

      // Re-read booking state under departure lock in case concurrent transaction already confirmed it
      const currentBooking = await this.bookingRepo.findById(command.bookingId, client);
      if (!currentBooking) {
        throw AppError.notFound('Booking not found', ErrorCodes.BOOKING_NOT_FOUND);
      }
      if (currentBooking.status === 'CONFIRMED') {
        return currentBooking;
      }

      // Verify inventory hold validity
      if (!currentBooking.holdId) {
        throw AppError.badRequest(
          'Booking has no associated inventory hold',
          [],
          ErrorCodes.HOLD_NOT_FOUND,
        );
      }

      const hold = await this.inventoryHoldRepo.findById(currentBooking.holdId, client);
      if (!hold || hold.status !== 'ACTIVE' || hold.expiresAt.getTime() <= Date.now()) {
        throw AppError.badRequest(
          'Inventory hold has expired or is invalid. Late payment cannot automatically confirm booking.',
          [{ field: 'holdId', issue: 'Hold is expired or non-active' }],
          ErrorCodes.INVENTORY_HOLD_EXPIRED,
        );
      }

      // Atomic guarded transition from AWAITING_PAYMENT -> CONFIRMED
      const confirmedBooking = await this.bookingRepo.updateStatusGuarded(
        booking.id,
        'AWAITING_PAYMENT',
        'CONFIRMED',
        { confirmedAt: new Date() },
        client,
      );

      if (!confirmedBooking) {
        throw AppError.conflict(
          'Booking was concurrently modified or confirmed',
          ErrorCodes.CONCURRENT_MUTATION_CONFLICT,
        );
      }

      // Guarded atomic update on inventory hold: ACTIVE -> COMMITTED
      const committedHold = await this.inventoryHoldRepo.updateStatusGuarded(
        hold.id,
        'ACTIVE',
        'COMMITTED',
        client,
      );

      if (!committedHold) {
        throw AppError.conflict(
          'Inventory hold was concurrently modified or expired',
          ErrorCodes.CONCURRENT_MUTATION_CONFLICT,
        );
      }

      // Increment booked seats on departure schedule
      await this.departureRepo.incrementBookedSeats(booking.departureId, booking.partySize, client);

      return confirmedBooking;
    });
  }

  /**
   * Domain primitive for customer or admin cancellation.
   *
   * Invariants:
   * - Strictly applies to `CONFIRMED` bookings (`CONFIRMED -> CANCELLED`).
   * - `booked_seats -= partySize` executed strictly once with atomic invariant guard (`booked_seats >= partySize`).
   * - If `AWAITING_PAYMENT`, `EXPIRED`, or already `CANCELLED`: rejected with appropriate domain error.
   */
  async cancelBooking(command: CancelBookingCommand): Promise<BookingEntity> {
    return this.db.withTransaction(async (client: pg.PoolClient) => {
      let booking: BookingEntity | null;

      if (command.customerId) {
        booking = await this.bookingRepo.findByReferenceAndCustomer(
          command.bookingReference,
          command.customerId,
          client,
        );
      } else {
        booking = await this.bookingRepo.findByReference(command.bookingReference, client);
      }

      if (!booking) {
        throw AppError.notFound('Booking not found', ErrorCodes.BOOKING_NOT_FOUND);
      }

      if (booking.status === 'CANCELLED') {
        throw AppError.badRequest(
          'Booking is already cancelled',
          [],
          ErrorCodes.BOOKING_ALREADY_CANCELLED,
        );
      }

      if (booking.status !== 'CONFIRMED') {
        throw AppError.badRequest(
          `Cannot cancel booking in status: ${booking.status}. Only CONFIRMED bookings can be cancelled.`,
          [{ field: 'status', issue: 'Only confirmed bookings are eligible for cancellation' }],
          ErrorCodes.BOOKING_INVALID_STATE,
        );
      }

      assertBookingTransition(booking.status, 'CANCELLED');

      // Acquire departure row lock first for consistent lock order: departure_schedules -> bookings
      const departure = await this.departureRepo.findByIdForUpdate(booking.departureId, client);
      if (!departure) {
        throw AppError.notFound('Departure schedule not found', ErrorCodes.RESOURCE_NOT_FOUND);
      }

      const cancelledBooking = await this.bookingRepo.updateStatusGuarded(
        booking.id,
        'CONFIRMED',
        'CANCELLED',
        {
          cancellationReason: command.reason ?? 'Customer requested cancellation',
          cancelledAt: new Date(),
        },
        client,
      );

      if (!cancelledBooking) {
        throw AppError.conflict(
          'Booking was concurrently modified',
          ErrorCodes.CONCURRENT_MUTATION_CONFLICT,
        );
      }

      // Single-decrement invariant: decrement booked seats strictly once with atomic invariant check
      const updatedDeparture = await this.departureRepo.decrementBookedSeats(
        booking.departureId,
        booking.partySize,
        client,
      );

      if (!updatedDeparture) {
        throw AppError.badRequest(
          'Failed to decrement booked seats: insufficient booked seats on departure schedule',
          [
            {
              field: 'bookedSeats',
              issue: 'Insufficient booked seats to satisfy cancellation decrement',
            },
          ],
          ErrorCodes.INVENTORY_CAPACITY_EXCEEDED,
        );
      }

      return cancelledBooking;
    });
  }

  /**
   * Domain primitive to mark an unpaid booking as EXPIRED when hold has timed out.
   * Does NOT decrement booked_seats (since seats were never committed).
   */
  async expireBooking(command: ExpireBookingCommand): Promise<BookingEntity> {
    return this.db.withTransaction(async (client: pg.PoolClient) => {
      const booking = await this.bookingRepo.findById(command.bookingId, client);
      if (!booking) {
        throw AppError.notFound('Booking not found', ErrorCodes.BOOKING_NOT_FOUND);
      }

      if (booking.status === 'EXPIRED') {
        return booking; // Idempotent
      }

      assertBookingTransition(booking.status, 'EXPIRED');

      // Canonical Lock Order: departure_schedules -> bookings -> inventory_holds
      const departure = await this.departureRepo.findByIdForUpdate(booking.departureId, client);
      if (!departure) {
        throw AppError.notFound('Departure schedule not found', ErrorCodes.RESOURCE_NOT_FOUND);
      }

      const expiredBooking = await this.bookingRepo.updateStatusGuarded(
        booking.id,
        'AWAITING_PAYMENT',
        'EXPIRED',
        {},
        client,
      );

      if (!expiredBooking) {
        throw AppError.conflict(
          'Booking was concurrently modified',
          ErrorCodes.CONCURRENT_MUTATION_CONFLICT,
        );
      }

      if (booking.holdId) {
        await this.inventoryHoldRepo.updateStatusGuarded(
          booking.holdId,
          'ACTIVE',
          'EXPIRED',
          client,
        );
      }

      return expiredBooking;
    });
  }

  /**
   * Domain primitive for background hold & booking expiration (Worker entry point).
   *
   * Idempotent & Concurrency Safe:
   * - If hold/booking already COMMITTED/CONFIRMED: returns outcome 'COMMITTED' without modifying state.
   * - If hold/booking already CANCELLED: returns outcome 'CANCELLED' without modifying state.
   * - If hold/booking already EXPIRED: returns outcome 'ALREADY_EXPIRED' idempotently.
   * - If AWAITING_PAYMENT + ACTIVE hold:
   *     1. Acquires departure lock (SELECT ... FOR UPDATE) for canonical lock order: departure_schedules -> bookings -> inventory_holds.
   *     2. Transitions booking: AWAITING_PAYMENT -> EXPIRED.
   *     3. Transitions hold: ACTIVE -> EXPIRED.
   *     4. Does NOT modify departure_schedules.booked_seats (seats were never committed).
   */
  async expireHoldAndBooking(
    holdId: string,
    bookingId?: string,
  ): Promise<{
    outcome: 'EXPIRED' | 'COMMITTED' | 'ALREADY_EXPIRED' | 'CANCELLED' | 'NO_OP';
    booking: BookingEntity | null;
    hold: InventoryHoldEntity | null;
  }> {
    return this.db.withTransaction(async (client: pg.PoolClient) => {
      // 1. Fetch hold
      const hold = await this.inventoryHoldRepo.findById(holdId, client);
      if (!hold) {
        return { outcome: 'NO_OP', booking: null, hold: null };
      }

      // Check if hold is already COMMITTED (payment confirmation won race)
      if (hold.status === 'COMMITTED') {
        const booking = bookingId
          ? await this.bookingRepo.findById(bookingId, client)
          : await this.bookingRepo.findByHoldId(holdId, client);
        return { outcome: 'COMMITTED', booking, hold };
      }

      // Check if hold is already RELEASED
      if (hold.status === 'RELEASED') {
        const booking = bookingId
          ? await this.bookingRepo.findById(bookingId, client)
          : await this.bookingRepo.findByHoldId(holdId, client);
        return { outcome: 'CANCELLED', booking, hold };
      }

      // Check if hold is already EXPIRED
      if (hold.status === 'EXPIRED') {
        const booking = bookingId
          ? await this.bookingRepo.findById(bookingId, client)
          : await this.bookingRepo.findByHoldId(holdId, client);
        return { outcome: 'ALREADY_EXPIRED', booking, hold };
      }

      // 2. Fetch associated booking
      const booking = bookingId
        ? await this.bookingRepo.findById(bookingId, client)
        : await this.bookingRepo.findByHoldId(holdId, client);

      if (booking) {
        if (booking.status === 'CONFIRMED') {
          return { outcome: 'COMMITTED', booking, hold };
        }

        if (booking.status === 'CANCELLED') {
          return { outcome: 'CANCELLED', booking, hold };
        }

        if (booking.status === 'EXPIRED') {
          if (hold.status === 'ACTIVE') {
            const updatedHold = await this.inventoryHoldRepo.updateStatusGuarded(
              hold.id,
              'ACTIVE',
              'EXPIRED',
              client,
            );
            return { outcome: 'EXPIRED', booking, hold: updatedHold ?? hold };
          }
          return { outcome: 'ALREADY_EXPIRED', booking, hold };
        }

        // Canonical Lock Order: departure_schedules -> bookings -> inventory_holds
        const departure = await this.departureRepo.findByIdForUpdate(booking.departureId, client);
        if (!departure) {
          throw AppError.notFound('Departure schedule not found', ErrorCodes.RESOURCE_NOT_FOUND);
        }

        const expiredBooking = await this.bookingRepo.updateStatusGuarded(
          booking.id,
          'AWAITING_PAYMENT',
          'EXPIRED',
          {},
          client,
        );

        const expiredHold = await this.inventoryHoldRepo.updateStatusGuarded(
          hold.id,
          'ACTIVE',
          'EXPIRED',
          client,
        );

        return {
          outcome: 'EXPIRED',
          booking: expiredBooking ?? booking,
          hold: expiredHold ?? hold,
        };
      }

      // No booking attached (orphan hold):
      const departure = await this.departureRepo.findByIdForUpdate(hold.departureId, client);
      if (!departure) {
        throw AppError.notFound('Departure schedule not found', ErrorCodes.RESOURCE_NOT_FOUND);
      }

      const expiredHold = await this.inventoryHoldRepo.updateStatusGuarded(
        hold.id,
        'ACTIVE',
        'EXPIRED',
        client,
      );

      return {
        outcome: 'EXPIRED',
        booking: null,
        hold: expiredHold ?? hold,
      };
    });
  }

  /**
   * Sweeper to process a batch of expired ACTIVE holds.
   */
  async sweepExpiredHolds(batchSize = 100): Promise<Array<{ holdId: string; outcome: string }>> {
    const expiredHolds = await this.inventoryHoldRepo.findExpiredActiveHolds(batchSize);
    const results: Array<{ holdId: string; outcome: string }> = [];

    for (const hold of expiredHolds) {
      const result = await this.expireHoldAndBooking(hold.id);
      results.push({ holdId: hold.id, outcome: result.outcome });
    }

    return results;
  }

  /**
   * Customer-isolated lookup by booking reference.
   */
  async getBookingByReference(
    reference: string,
    customerId?: string,
  ): Promise<BookingDetailsResult> {
    const booking = customerId
      ? await this.bookingRepo.findByReferenceAndCustomer(reference, customerId)
      : await this.bookingRepo.findByReference(reference);

    if (!booking) {
      throw AppError.notFound('Booking not found', ErrorCodes.BOOKING_NOT_FOUND);
    }

    const passengerEntities = await this.passengerRepo.findByBookingId(booking.id);
    const passengers: PassengerDto[] = passengerEntities.map((p) => ({
      id: p.id,
      passengerType: p.passengerType,
      fullName: p.fullName,
      dateOfBirth: p.dateOfBirth,
      ageAtBooking: p.ageAtBooking,
      gender: p.gender,
      isPrimaryContact: p.isPrimaryContact,
      specialRequests: p.specialRequests,
      createdAt: p.createdAt.toISOString(),
    }));

    let holdExpiresAt: string | null = null;
    if (booking.holdId) {
      const hold = await this.inventoryHoldRepo.findById(booking.holdId);
      if (hold) {
        holdExpiresAt =
          hold.expiresAt instanceof Date ? hold.expiresAt.toISOString() : String(hold.expiresAt);
      }
    }

    return { booking, passengers, holdExpiresAt };
  }

  /**
   * Paginated customer booking history.
   */
  async getCustomerBookings(
    customerId: string,
    options: BookingListOptions = {},
  ): Promise<BookingListResult> {
    return this.bookingRepo.findByCustomerId(customerId, options);
  }

  /**
   * Admin booking details lookup.
   */
  async getAdminBookingDetails(reference: string): Promise<BookingDetailsResult> {
    return this.getBookingByReference(reference);
  }

  /**
   * Admin paginated booking search & audit list.
   */
  async listAdminBookings(options: AdminBookingListOptions = {}): Promise<AdminBookingListResult> {
    return this.bookingRepo.listAdmin(options);
  }

  /**
   * Admin departure passenger manifest retrieval.
   */
  async getDepartureManifest(departureId: string): Promise<DepartureManifestEntity | null> {
    return this.bookingRepo.findDepartureManifest(departureId);
  }
}
