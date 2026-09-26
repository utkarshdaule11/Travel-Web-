import { z } from 'zod';
import { BOOKING_STATUSES, PASSENGER_TYPES, PASSENGER_GENDERS } from '../types/booking.js';

// ISO Date regex (YYYY-MM-DD)
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Phone number regex allowing international prefix, spaces, hyphens, and digits
const PHONE_REGEX = /^\+?[0-9\s\-()]{7,30}$/;

// ============================================================
// 1. Primitive & Sub-entity Schemas
// ============================================================

export const bookingStatusSchema = z.enum(BOOKING_STATUSES);
export const passengerTypeSchema = z.enum(PASSENGER_TYPES);
export const passengerGenderSchema = z.enum(PASSENGER_GENDERS);

/**
 * primaryContactSchema: Validates primary customer contact information.
 */
export const primaryContactSchema = z
  .object({
    name: z
      .string({ required_error: 'Primary contact name is required' })
      .trim()
      .min(2, 'Name must be at least 2 characters long')
      .max(120, 'Name must not exceed 120 characters'),

    email: z
      .string({ required_error: 'Primary contact email is required' })
      .trim()
      .toLowerCase()
      .email('Invalid email address format')
      .max(255, 'Email must not exceed 255 characters'),

    phone: z
      .string({ required_error: 'Primary contact phone is required' })
      .trim()
      .regex(PHONE_REGEX, 'Invalid phone number format')
      .min(7, 'Phone number must be at least 7 characters')
      .max(30, 'Phone number must not exceed 30 characters'),
  })
  .strict();

export type PrimaryContactInput = z.infer<typeof primaryContactSchema>;

/**
 * createPassengerSchema: Validates individual passenger input on booking creation.
 */
export const createPassengerSchema = z
  .object({
    passengerType: passengerTypeSchema,

    fullName: z
      .string({ required_error: 'Passenger full name is required' })
      .trim()
      .min(2, 'Passenger full name must be at least 2 characters long')
      .max(120, 'Passenger full name must not exceed 120 characters'),

    dateOfBirth: z
      .string()
      .regex(ISO_DATE_REGEX, 'Date of birth must be in YYYY-MM-DD format')
      .nullable()
      .optional(),

    ageAtBooking: z
      .number({ required_error: 'Age at booking is required' })
      .int('Age must be an integer')
      .min(0, 'Age cannot be negative')
      .max(120, 'Age cannot exceed 120 years'),

    gender: passengerGenderSchema,

    isPrimaryContact: z.boolean().optional().default(false),

    specialRequests: z
      .string()
      .trim()
      .max(500, 'Special requests must not exceed 500 characters')
      .nullable()
      .optional(),
  })
  .strict();

export type CreatePassengerInput = z.infer<typeof createPassengerSchema>;

// ============================================================
// 2. Booking Request & Mutation Schemas
// ============================================================

/**
 * createBookingSchema: Validates `POST /api/v1/bookings` creation payload.
 *
 * Rules:
 * - departureId: valid UUID
 * - partySize >= 1
 * - adultCount >= 0, childCount >= 0
 * - partySize === adultCount + childCount
 * - passengers.length === partySize
 * - passengers adult/child counts exactly match adultCount and childCount
 * - Server-controlled fields are strictly excluded
 */
export const createBookingSchema = z
  .object({
    departureId: z
      .string({ required_error: 'Departure ID is required' })
      .uuid('Departure ID must be a valid UUID'),

    partySize: z
      .number({ required_error: 'Party size is required' })
      .int('Party size must be an integer')
      .min(1, 'Party size must be at least 1 passenger'),

    adultCount: z
      .number()
      .int('Adult count must be an integer')
      .min(0, 'Adult count cannot be negative')
      .optional()
      .default(1),

    childCount: z
      .number()
      .int('Child count must be an integer')
      .min(0, 'Child count cannot be negative')
      .optional()
      .default(0),

    passengers: z.array(createPassengerSchema).min(1, 'At least one passenger record is required'),

    primaryContact: primaryContactSchema,
  })
  .strict()
  .refine((data) => data.partySize === data.adultCount + data.childCount, {
    message: 'Party size must equal the sum of adult count and child count',
    path: ['partySize'],
  })
  .refine((data) => data.passengers.length === data.partySize, {
    message: 'Number of passenger records must match party size',
    path: ['passengers'],
  })
  .refine(
    (data) => {
      const adultPassengers = data.passengers.filter((p) => p.passengerType === 'ADULT').length;
      return adultPassengers === data.adultCount;
    },
    {
      message: 'Number of adult passengers must match adultCount',
      path: ['passengers'],
    },
  )
  .refine(
    (data) => {
      const childPassengers = data.passengers.filter((p) => p.passengerType === 'CHILD').length;
      return childPassengers === data.childCount;
    },
    {
      message: 'Number of child passengers must match childCount',
      path: ['passengers'],
    },
  );

export type CreateBookingInput = z.infer<typeof createBookingSchema>;

/**
 * cancelBookingSchema: Validates `POST /api/v1/bookings/:reference/cancel` payload.
 */
export const cancelBookingSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .max(500, 'Cancellation reason must not exceed 500 characters')
      .nullable()
      .optional(),
  })
  .strict();

export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;

// ============================================================
// 3. Query Parameter Schemas
// ============================================================

/**
 * bookingListQuerySchema: Validates query parameters for customer booking history.
 */
export const bookingListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1, 'Page must be at least 1').optional().default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'Limit must be at least 1')
      .max(50, 'Limit must not exceed 50')
      .optional()
      .default(10),
    status: bookingStatusSchema.optional(),
  })
  .strict();

export type BookingListQueryInput = z.infer<typeof bookingListQuerySchema>;

/**
 * adminBookingListQuerySchema: Validates query parameters for admin booking search.
 */
export const adminBookingListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1, 'Page must be at least 1').optional().default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'Limit must be at least 1')
      .max(50, 'Limit must not exceed 50')
      .optional()
      .default(10),
    status: bookingStatusSchema.optional(),
    departureId: z.string().uuid('Departure ID must be a valid UUID').optional(),
    customerId: z.string().uuid('Customer ID must be a valid UUID').optional(),
    search: z.string().trim().max(100).optional(),
  })
  .strict();

export type AdminBookingListQueryInput = z.infer<typeof adminBookingListQuerySchema>;

// ============================================================
// 4. Idempotency Header Schema
// ============================================================

/**
 * idempotencyHeaderSchema: Validates `Idempotency-Key` HTTP header.
 */
export const idempotencyHeaderSchema = z
  .object({
    'idempotency-key': z
      .string({ required_error: 'Idempotency-Key header is required' })
      .trim()
      .min(1, 'Idempotency-Key header cannot be empty')
      .max(128, 'Idempotency-Key header must not exceed 128 characters'),
  })
  .passthrough();

export type IdempotencyHeaderInput = z.infer<typeof idempotencyHeaderSchema>;

// ============================================================
// 5. Snapshot Schemas
// ============================================================

export const priceBreakdownSnapshotSchema = z
  .object({
    adultCount: z.number().int().min(0),
    adultUnitPrice: z.number().int().min(0),
    adultSubtotal: z.number().int().min(0),
    childCount: z.number().int().min(0),
    childUnitPrice: z.number().int().min(0),
    childSubtotal: z.number().int().min(0),
    baseSubtotal: z.number().int().min(0),
    discountAmount: z.number().int().min(0),
    totalPrice: z.number().int().min(0),
    currency: z.enum(['INR', 'USD']),
    calculatedAt: z.string().datetime(),
  })
  .strict();

export const packageSnapshotSchema = z
  .object({
    packageId: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    shortDescription: z.string(),
    durationDays: z.number().int().positive(),
    durationNights: z.number().int().nonnegative(),
    originCity: z.string(),
    destinationCity: z.string(),
    destinationCountry: z.string(),
    heroImageUrl: z.string().url(),
    inclusions: z.array(z.string()),
    exclusions: z.array(z.string()),
    accommodationTier: z.string().nullable().optional(),
    mealPlan: z.string().nullable().optional(),
  })
  .strict();

export const departureSnapshotSchema = z
  .object({
    departureId: z.string().uuid(),
    departureDate: z.string().regex(ISO_DATE_REGEX),
    returnDate: z.string().regex(ISO_DATE_REGEX),
    pricingApplied: z
      .object({
        basePriceAdult: z.number().int().min(0),
        basePriceChild: z.number().int().min(0),
        singleSupplementPrice: z.number().int().min(0).nullable().optional(),
        currency: z.enum(['INR', 'USD']),
      })
      .strict(),
    statusAtBooking: z.string(),
  })
  .strict();

export const itineraryDaySnapshotSchema = z
  .object({
    dayNumber: z.number().int().positive(),
    title: z.string(),
    activityDescription: z.string(),
    mealsIncluded: z.array(z.string()),
    accommodationNotes: z.string().nullable().optional(),
  })
  .strict();

export const itinerarySnapshotSchema = z.array(itineraryDaySnapshotSchema);
