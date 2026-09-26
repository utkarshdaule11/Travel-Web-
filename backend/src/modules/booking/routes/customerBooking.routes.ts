import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { CustomerBookingController } from '../controllers/customerBooking.controller.js';
import { BookingService } from '../services/booking.service.js';

export interface CustomerBookingRoutesOptions {
  bookingService: BookingService;
}

export const customerBookingRoutes: FastifyPluginAsync<CustomerBookingRoutesOptions> = async (
  fastify: FastifyInstance,
  options,
) => {
  const controller = new CustomerBookingController(options.bookingService);

  // All customer booking routes enforce customer authentication via preHandler hook
  fastify.addHook('preHandler', fastify.authenticate);

  // 1. POST /api/v1/bookings
  fastify.post(
    '/',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Create a new tour booking and 15-minute inventory hold',
        description:
          'Atomically creates an unconfirmed booking in AWAITING_PAYMENT status and reserves inventory for 15 minutes.',
      },
    },
    controller.createBooking,
  );

  // 2. GET /api/v1/bookings
  fastify.get(
    '/',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'List authenticated customer bookings with pagination',
        description:
          'Returns paginated booking history for the authenticated customer ordered by creation date descending.',
      },
    },
    controller.listCustomerBookings,
  );

  // 3. GET /api/v1/bookings/:reference
  fastify.get(
    '/:reference',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Get customer booking details by booking reference',
        description:
          'Returns full booking details, snapshots, passenger roster, and hold status for the authenticated owner.',
      },
    },
    controller.getBookingByReference,
  );

  // 4. POST /api/v1/bookings/:reference/cancel
  fastify.post(
    '/:reference/cancel',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Cancel an eligible customer booking',
        description:
          'Cancels a CONFIRMED booking, decrements departure booked seats by party size, and records cancellation audit.',
      },
    },
    controller.cancelBooking,
  );
};
