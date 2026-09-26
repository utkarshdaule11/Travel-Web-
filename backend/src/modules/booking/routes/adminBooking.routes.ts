import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AdminBookingController } from '../controllers/adminBooking.controller.js';
import { BookingService } from '../services/booking.service.js';

export interface AdminBookingRoutesOptions {
  bookingService: BookingService;
}

export const adminBookingRoutes: FastifyPluginAsync<AdminBookingRoutesOptions> = async (
  fastify: FastifyInstance,
  options,
) => {
  const controller = new AdminBookingController(options.bookingService);

  // Apply strict Authentication & ADMIN RBAC Guard across all admin booking routes
  fastify.addHook('preHandler', fastify.authenticate);
  fastify.addHook('preHandler', fastify.authorize(['ADMIN']));

  const adminSecurity = [{ BearerAuth: [] }];

  // GET /api/v1/admin/bookings
  fastify.get(
    '/bookings',
    {
      schema: {
        tags: ['Admin — Bookings'],
        summary: 'Admin list all bookings with filtering and pagination',
        security: adminSecurity,
      },
    },
    controller.listBookings,
  );

  // GET /api/v1/admin/bookings/:reference
  fastify.get(
    '/bookings/:reference',
    {
      schema: {
        tags: ['Admin — Bookings'],
        summary: 'Admin get booking details by reference',
        security: adminSecurity,
      },
    },
    controller.getBookingByReference,
  );

  // GET /api/v1/admin/departures/:departureId/manifest
  fastify.get(
    '/departures/:departureId/manifest',
    {
      schema: {
        tags: ['Admin — Bookings'],
        summary: 'Admin get departure passenger manifest',
        security: adminSecurity,
      },
    },
    controller.getDepartureManifest,
  );
};
