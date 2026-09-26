import { SupportedCurrency } from '../utils/money.js';

// ============================================================
// 1. Controlled Enums & Taxonomies
// ============================================================

/**
 * BookingStatus: Canonical lifecycle stored in PostgreSQL enum `booking_status`.
 * Matches database enum: ('AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED').
 */
export const BOOKING_STATUSES = ['AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * PassengerType: Canonical passenger classification stored in PostgreSQL enum `passenger_type`.
 * Matches database enum: ('ADULT', 'CHILD').
 */
export const PASSENGER_TYPES = ['ADULT', 'CHILD'] as const;
export type PassengerType = (typeof PASSENGER_TYPES)[number];

/**
 * PassengerGender: Stored in PostgreSQL enum `passenger_gender`.
 * Matches database enum: ('MALE', 'FEMALE', 'OTHER').
 */
export const PASSENGER_GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export type PassengerGender = (typeof PASSENGER_GENDERS)[number];

// ============================================================
// 2. Immutable Historical Snapshots
// ============================================================

/**
 * PriceBreakdownSnapshot: Immutable historical pricing calculation JSONB snapshot.
 */
export interface PriceBreakdownSnapshot {
  adultCount: number;
  adultUnitPrice: number; // Minor units (e.g. paise / cents)
  adultSubtotal: number; // Minor units
  childCount: number;
  childUnitPrice: number; // Minor units
  childSubtotal: number; // Minor units
  baseSubtotal: number; // Minor units
  discountAmount: number; // Minor units
  totalPrice: number; // Minor units
  currency: SupportedCurrency;
  calculatedAt: string; // ISO timestamp
}

/**
 * PackageSnapshot: Immutable historical package metadata JSONB snapshot.
 */
export interface PackageSnapshot {
  packageId: string;
  slug: string;
  title: string;
  shortDescription: string;
  durationDays: number;
  durationNights: number;
  originCity: string;
  destinationCity: string;
  destinationCountry: string;
  heroImageUrl: string;
  inclusions: string[];
  exclusions: string[];
  accommodationTier?: string | null;
  mealPlan?: string | null;
}

/**
 * DeparturePricingApplied: Pricing rules applied to departure at the time of booking.
 */
export interface DeparturePricingApplied {
  basePriceAdult: number; // Minor units
  basePriceChild: number; // Minor units
  singleSupplementPrice?: number | null;
  currency: SupportedCurrency;
}

/**
 * DepartureSnapshot: Immutable historical departure schedule JSONB snapshot.
 */
export interface DepartureSnapshot {
  departureId: string;
  departureDate: string; // ISO date YYYY-MM-DD
  returnDate: string; // ISO date YYYY-MM-DD
  pricingApplied: DeparturePricingApplied;
  statusAtBooking: string;
}

/**
 * ItineraryDaySnapshot: Immutable historical day item in itinerary snapshot.
 */
export interface ItineraryDaySnapshot {
  dayNumber: number;
  title: string;
  activityDescription: string;
  mealsIncluded: string[];
  accommodationNotes?: string | null;
}

/**
 * ItinerarySnapshot: Immutable historical day-by-day itinerary JSONB snapshot.
 */
export type ItinerarySnapshot = ItineraryDaySnapshot[];

// ============================================================
// 3. Passenger & Contact Models
// ============================================================

/**
 * PrimaryContactDto: Primary customer contact details associated with a booking.
 */
export interface PrimaryContactDto {
  name: string;
  email: string;
  phone: string;
}

/**
 * PassengerDto: Full passenger record matching `booking_passengers` table.
 */
export interface PassengerDto {
  id?: string;
  passengerType: PassengerType;
  fullName: string;
  dateOfBirth?: string | null; // ISO date YYYY-MM-DD
  ageAtBooking: number;
  gender: PassengerGender;
  isPrimaryContact: boolean;
  specialRequests?: string | null; // Non-sensitive travel preferences
  createdAt?: string;
}

/**
 * CreatePassengerDto: Passenger input for booking creation.
 */
export interface CreatePassengerDto {
  passengerType: PassengerType;
  fullName: string;
  dateOfBirth?: string | null; // ISO date YYYY-MM-DD
  ageAtBooking: number;
  gender: PassengerGender;
  isPrimaryContact?: boolean;
  specialRequests?: string | null;
}

// ============================================================
// 4. Booking Request & Response DTOs
// ============================================================

/**
 * CreateBookingDto: Request payload for `POST /api/v1/bookings`.
 * Server-controlled fields (id, bookingReference, totalPrice, status, timestamps) are strictly excluded.
 */
export interface CreateBookingDto {
  departureId: string;
  partySize: number;
  adultCount: number;
  childCount: number;
  passengers: CreatePassengerDto[];
  primaryContact: PrimaryContactDto;
}

/**
 * BookingSummaryDto: Compact booking record for listings and customer dashboard.
 */
export interface BookingSummaryDto {
  id: string;
  bookingReference: string;
  customerId: string;
  departureId: string;
  partySize: number;
  adultCount: number;
  childCount: number;
  totalPrice: number; // Minor units
  currency: SupportedCurrency;
  status: BookingStatus;
  primaryContact: PrimaryContactDto;
  packageTitle: string;
  departureDate: string; // ISO date YYYY-MM-DD
  returnDate: string; // ISO date YYYY-MM-DD
  createdAt: string; // ISO timestamp
  confirmedAt?: string | null;
  cancelledAt?: string | null;
}

/**
 * BookingDetailsDto: Full detailed booking representation for customer and admin inspection.
 */
export interface BookingDetailsDto extends BookingSummaryDto {
  holdId?: string | null;
  holdExpiresAt?: string | null;
  passengers: PassengerDto[];
  priceBreakdown: PriceBreakdownSnapshot;
  packageSnapshot: PackageSnapshot;
  departureSnapshot: DepartureSnapshot;
  itinerarySnapshot: ItinerarySnapshot;
  cancellationReason?: string | null;
  updatedAt: string;
}

/**
 * CancelBookingDto: Request payload for `POST /api/v1/bookings/:reference/cancel`.
 */
export interface CancelBookingDto {
  reason?: string | null;
}

/**
 * CancelBookingResponseDto: Response payload following successful cancellation.
 */
export interface CancelBookingResponseDto {
  bookingReference: string;
  status: BookingStatus;
  cancelledAt: string;
  cancellationReason?: string | null;
}

/**
 * BookingListQueryDto: Query parameters for customer booking history (`GET /api/v1/bookings`).
 */
export interface BookingListQueryDto {
  page?: number;
  limit?: number;
  status?: BookingStatus;
}

// ============================================================
// 5. Admin & Departure Passenger Manifest Contracts
// ============================================================

/**
 * AdminBookingListQueryDto: Query parameters for admin booking management (`GET /api/v1/admin/bookings`).
 */
export interface AdminBookingListQueryDto {
  page?: number;
  limit?: number;
  status?: BookingStatus;
  departureId?: string;
  customerId?: string;
  search?: string;
}

/**
 * DepartureManifestPassengerDto: Passenger entry within an admin departure manifest.
 */
export interface DepartureManifestPassengerDto {
  passengerId?: string;
  bookingReference: string;
  customerName: string;
  customerEmail: string;
  passengerType: PassengerType;
  fullName: string;
  ageAtBooking: number;
  gender: PassengerGender;
  isPrimaryContact: boolean;
  specialRequests?: string | null;
  bookingStatus: BookingStatus;
}

/**
 * DepartureManifestDto: Comprehensive passenger manifest for tour guides/operators (`GET /api/v1/admin/departures/:id/manifest`).
 */
export interface DepartureManifestDto {
  departureId: string;
  packageId: string;
  packageTitle: string;
  departureDate: string;
  returnDate: string;
  totalCapacity: number;
  bookedSeats: number;
  totalPassengers: number;
  adultPassengers: number;
  childPassengers: number;
  passengers: DepartureManifestPassengerDto[];
}
