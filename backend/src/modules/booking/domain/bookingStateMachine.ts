import { AppError, BookingStatus, ErrorCodes } from '../../../../../shared/src/index.js';

/**
 * Valid transitions map for the canonical Booking lifecycle state machine.
 *
 * Canonical State Transition Matrix:
 * - AWAITING_PAYMENT -> CONFIRMED (on verified payment capture & active unexpired hold)
 * - AWAITING_PAYMENT -> EXPIRED   (on 15-minute hold timeout)
 * - CONFIRMED        -> CANCELLED (on verified customer / admin cancellation)
 *
 * Strict Invariants:
 * - EXPIRED is a terminal dead state. Expired bookings with late payments CANNOT transition to CONFIRMED.
 * - CANCELLED is a terminal void state.
 * - CONFIRMED is a stable state; cannot transition to EXPIRED or AWAITING_PAYMENT.
 * - AWAITING_PAYMENT only transitions to CONFIRMED (on payment) or EXPIRED (on timeout).
 */
export const VALID_BOOKING_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> =
  {
    AWAITING_PAYMENT: ['CONFIRMED', 'EXPIRED'],
    CONFIRMED: ['CANCELLED'],
    CANCELLED: [],
    EXPIRED: [],
  };

/**
 * Check if a booking state transition is logically valid.
 */
export function canTransitionBooking(from: BookingStatus, to: BookingStatus): boolean {
  if (from === to) {
    return false;
  }
  const allowed = VALID_BOOKING_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Assert that a booking transition is valid, throwing a domain AppError if forbidden.
 */
export function assertBookingTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransitionBooking(from, to)) {
    throw AppError.badRequest(
      `Invalid booking state transition from ${from} to ${to}`,
      [{ field: 'status', issue: `Cannot transition from ${from} to ${to}` }],
      ErrorCodes.BOOKING_INVALID_STATE,
    );
  }
}

/**
 * Check if a state is terminal (no further transitions permitted).
 */
export function isTerminalBookingStatus(status: BookingStatus): boolean {
  return VALID_BOOKING_TRANSITIONS[status]?.length === 0;
}
