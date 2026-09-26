import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  ErrorCodes,
  adminBookingListQuerySchema,
  BookingDetailsDto,
  BookingSummaryDto,
  DepartureManifestDto,
} from '../../../../../shared/src/index.js';
import { BookingService } from '../services/booking.service.js';
import {
  mapSummaryEntityToDto,
  mapBookingEntityToDetailsDto,
} from './customerBooking.controller.js';

const bookingReferenceParamSchema = z
  .object({
    reference: z
      .string({ required_error: 'Booking reference is required' })
      .trim()
      .min(1, 'Booking reference cannot be empty')
      .max(64, 'Booking reference must not exceed 64 characters'),
  })
  .strict();

const departureManifestParamsSchema = z
  .object({
    departureId: z
      .string({ required_error: 'Departure ID is required' })
      .uuid('Departure ID must be a valid UUID'),
  })
  .strict();

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

export class AdminBookingController {
  constructor(private readonly bookingService: BookingService) {}

  /**
   * GET /api/v1/admin/bookings
   * List paginated bookings with operational search and filtering.
   */
  listBookings = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const query = parseZod(adminBookingListQuerySchema, request.query, 'query');
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const result = await this.bookingService.listAdminBookings({
      page,
      limit,
      status: query.status,
      departureId: query.departureId,
      customerId: query.customerId,
      search: query.search,
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
   * GET /api/v1/admin/bookings/:reference
   * Retrieve single booking details by booking reference for administrative/operational audit.
   */
  getBookingByReference = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { reference } = parseZod(bookingReferenceParamSchema, request.params, 'params');
    const result = await this.bookingService.getAdminBookingDetails(reference);

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
   * GET /api/v1/admin/departures/:departureId/manifest
   * Retrieve operational passenger manifest for a departure (CONFIRMED passengers only).
   */
  getDepartureManifest = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { departureId } = parseZod(departureManifestParamsSchema, request.params, 'params');
    const manifest = await this.bookingService.getDepartureManifest(departureId);

    if (!manifest) {
      throw AppError.notFound('Departure schedule not found', ErrorCodes.RESOURCE_NOT_FOUND);
    }

    const data: DepartureManifestDto = {
      departureId: manifest.departureId,
      packageId: manifest.packageId,
      packageTitle: manifest.packageTitle,
      departureDate: manifest.departureDate,
      returnDate: manifest.returnDate,
      totalCapacity: manifest.totalCapacity,
      bookedSeats: manifest.bookedSeats,
      totalPassengers: manifest.totalPassengers,
      adultPassengers: manifest.adultPassengers,
      childPassengers: manifest.childPassengers,
      passengers: manifest.passengers.map((p) => ({
        passengerId: p.passengerId,
        bookingReference: p.bookingReference,
        customerName: p.customerName,
        customerEmail: p.customerEmail,
        passengerType: p.passengerType,
        fullName: p.fullName,
        ageAtBooking: p.ageAtBooking,
        gender: p.gender,
        isPrimaryContact: p.isPrimaryContact,
        specialRequests: p.specialRequests,
        bookingStatus: p.bookingStatus,
      })),
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
