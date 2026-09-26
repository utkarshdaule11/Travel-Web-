import crypto from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  ErrorCodes,
  createBookingSchema,
  cancelBookingSchema,
  bookingListQuerySchema,
  BookingDetailsDto,
  BookingSummaryDto,
  CancelBookingResponseDto,
  PassengerDto,
} from '../../../../../shared/src/index.js';
import { BookingEntity, BookingSummaryEntity } from '../repositories/booking.repository.js';
import { BookingService } from '../services/booking.service.js';

const bookingReferenceParamSchema = z.object({
  reference: z
    .string({ required_error: 'Booking reference is required' })
    .trim()
    .min(1, 'Booking reference cannot be empty')
    .max(64, 'Booking reference must not exceed 64 characters'),
});

function parseZod<T>(schema: z.ZodType<T, any, any>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.') || context,
      issue: i.message,
    }));
    throw AppError.badRequest(`Request ${context} validation failed`, details);
  }
  return result.data;
}

export function mapSummaryEntityToDto(entity: BookingSummaryEntity): BookingSummaryDto {
  return {
    id: entity.id,
    bookingReference: entity.bookingReference,
    customerId: entity.customerId,
    departureId: entity.departureId,
    partySize: entity.partySize,
    adultCount: entity.adultCount,
    childCount: entity.childCount,
    totalPrice: entity.totalPrice,
    currency: entity.currency,
    status: entity.status,
    primaryContact: entity.primaryContact,
    packageTitle: entity.packageTitle,
    departureDate: entity.departureDate,
    returnDate: entity.returnDate,
    createdAt:
      entity.createdAt instanceof Date ? entity.createdAt.toISOString() : String(entity.createdAt),
    confirmedAt: entity.confirmedAt
      ? entity.confirmedAt instanceof Date
        ? entity.confirmedAt.toISOString()
        : String(entity.confirmedAt)
      : null,
    cancelledAt: entity.cancelledAt
      ? entity.cancelledAt instanceof Date
        ? entity.cancelledAt.toISOString()
        : String(entity.cancelledAt)
      : null,
  };
}

export function mapBookingEntityToDetailsDto(
  booking: BookingEntity,
  passengers: PassengerDto[],
  holdExpiresAt?: string | null,
): BookingDetailsDto {
  return {
    id: booking.id,
    bookingReference: booking.bookingReference,
    customerId: booking.customerId,
    departureId: booking.departureId,
    holdId: booking.holdId,
    holdExpiresAt: holdExpiresAt ?? null,
    partySize: booking.partySize,
    adultCount: booking.adultCount,
    childCount: booking.childCount,
    totalPrice: booking.totalPrice,
    currency: booking.currency,
    status: booking.status,
    primaryContact: booking.primaryContact,
    packageTitle: booking.packageSnapshot?.title ?? '',
    departureDate: booking.departureSnapshot?.departureDate ?? '',
    returnDate: booking.departureSnapshot?.returnDate ?? '',
    passengers,
    priceBreakdown: booking.priceBreakdown,
    packageSnapshot: booking.packageSnapshot,
    departureSnapshot: booking.departureSnapshot,
    itinerarySnapshot: booking.itinerarySnapshot,
    cancellationReason: booking.cancellationReason,
    createdAt:
      booking.createdAt instanceof Date
        ? booking.createdAt.toISOString()
        : String(booking.createdAt),
    updatedAt:
      booking.updatedAt instanceof Date
        ? booking.updatedAt.toISOString()
        : String(booking.updatedAt),
    confirmedAt: booking.confirmedAt
      ? booking.confirmedAt instanceof Date
        ? booking.confirmedAt.toISOString()
        : String(booking.confirmedAt)
      : null,
    cancelledAt: booking.cancelledAt
      ? booking.cancelledAt instanceof Date
        ? booking.cancelledAt.toISOString()
        : String(booking.cancelledAt)
      : null,
  };
}

export class CustomerBookingController {
  constructor(private readonly bookingService: BookingService) {}

  /**
   * POST /api/v1/bookings
   * Create a new tour booking and a 15-minute uncommitted inventory hold.
   */
  createBooking = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = request.user?.userId;
    if (!userId) {
      throw AppError.unauthorized('Authentication required', ErrorCodes.UNAUTHORIZED);
    }

    // 1. Idempotency-Key Header extraction & validation
    const rawIdempotencyKey = request.headers['idempotency-key'];
    if (
      !rawIdempotencyKey ||
      typeof rawIdempotencyKey !== 'string' ||
      rawIdempotencyKey.trim().length === 0
    ) {
      throw AppError.badRequest('Idempotency-Key header is required', [
        { field: 'idempotency-key', issue: 'Header is missing or empty' },
      ]);
    }

    const idempotencyKey = rawIdempotencyKey.trim();
    if (idempotencyKey.length > 128) {
      throw AppError.badRequest('Idempotency-Key header must not exceed 128 characters', [
        { field: 'idempotency-key', issue: 'Length exceeds 128 characters' },
      ]);
    }

    // 2. Validate request body against canonical createBookingSchema
    const bookingData = parseZod(createBookingSchema, request.body, 'body');

    // 3. Compute deterministic request SHA-256 hash
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(bookingData))
      .digest('hex');

    // 4. Orchestrate booking creation through BookingService
    const result = await this.bookingService.createBooking({
      userId,
      endpointScope: 'POST:/api/v1/bookings',
      idempotencyKey,
      requestHash,
      bookingData,
    });

    const holdExpiresAt = result.hold?.expiresAt
      ? result.hold.expiresAt instanceof Date
        ? result.hold.expiresAt.toISOString()
        : String(result.hold.expiresAt)
      : null;

    const data: BookingDetailsDto = mapBookingEntityToDetailsDto(
      result.booking,
      result.passengers,
      holdExpiresAt,
    );

    return reply.status(201).send({
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: typeof request.id === 'string' ? request.id : undefined,
        isReplay: result.isReplay ?? false,
      },
    });
  };

  /**
   * GET /api/v1/bookings
   * List paginated booking history for the authenticated customer.
   */
  listCustomerBookings = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = request.user?.userId;
    if (!userId) {
      throw AppError.unauthorized('Authentication required', ErrorCodes.UNAUTHORIZED);
    }

    const query = parseZod(bookingListQuerySchema, request.query, 'query');
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const result = await this.bookingService.getCustomerBookings(userId, {
      page,
      limit,
      status: query.status,
    });

    const bookings: BookingSummaryDto[] = result.bookings.map(mapSummaryEntityToDto);
    const totalPages = Math.ceil(result.total / limit) || 1;

    return reply.status(200).send({
      success: true,
      data: bookings,
      meta: {
        page,
        limit,
        totalItems: result.total,
        totalPages,
        timestamp: new Date().toISOString(),
        requestId: typeof request.id === 'string' ? request.id : undefined,
      },
    });
  };

  /**
   * GET /api/v1/bookings/:reference
   * Retrieve single booking details by booking reference with ownership isolation.
   */
  getBookingByReference = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = request.user?.userId;
    if (!userId) {
      throw AppError.unauthorized('Authentication required', ErrorCodes.UNAUTHORIZED);
    }

    const { reference } = parseZod(bookingReferenceParamSchema, request.params, 'params');
    const result = await this.bookingService.getBookingByReference(reference, userId);

    const holdExpiresAt = result.holdExpiresAt ?? null;
    const data: BookingDetailsDto = mapBookingEntityToDetailsDto(
      result.booking,
      result.passengers,
      holdExpiresAt,
    );

    return reply.status(200).send({
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: typeof request.id === 'string' ? request.id : undefined,
      },
    });
  };

  /**
   * POST /api/v1/bookings/:reference/cancel
   * Cancel an eligible CONFIRMED customer booking and release booked seats.
   */
  cancelBooking = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = request.user?.userId;
    if (!userId) {
      throw AppError.unauthorized('Authentication required', ErrorCodes.UNAUTHORIZED);
    }

    const { reference } = parseZod(bookingReferenceParamSchema, request.params, 'params');
    const body = parseZod(cancelBookingSchema, request.body ?? {}, 'body');

    const cancelledBooking = await this.bookingService.cancelBooking({
      bookingReference: reference,
      customerId: userId,
      reason: body.reason ?? 'Customer requested cancellation',
    });

    const data: CancelBookingResponseDto = {
      bookingReference: cancelledBooking.bookingReference,
      status: cancelledBooking.status,
      cancelledAt: cancelledBooking.cancelledAt
        ? cancelledBooking.cancelledAt instanceof Date
          ? cancelledBooking.cancelledAt.toISOString()
          : String(cancelledBooking.cancelledAt)
        : new Date().toISOString(),
      cancellationReason: cancelledBooking.cancellationReason,
    };

    return reply.status(200).send({
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: typeof request.id === 'string' ? request.id : undefined,
      },
    });
  };
}
