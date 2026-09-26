import { describe, it, expect } from 'vitest';
import { BookingStatus, BOOKING_STATUSES, AppError, ErrorCodes } from '../../shared/src/index.js';
import {
  canTransitionBooking,
  assertBookingTransition,
  isTerminalBookingStatus,
  VALID_BOOKING_TRANSITIONS,
} from '../../backend/src/modules/booking/domain/bookingStateMachine.js';

describe('Phase 5 Step 4 — Booking State Machine Domain Logic', () => {
  describe('State Transition Rules Matrix', () => {
    it('allows valid transitions from AWAITING_PAYMENT', () => {
      expect(canTransitionBooking('AWAITING_PAYMENT', 'CONFIRMED')).toBe(true);
      expect(canTransitionBooking('AWAITING_PAYMENT', 'EXPIRED')).toBe(true);
      expect(canTransitionBooking('AWAITING_PAYMENT', 'CANCELLED')).toBe(false);

      // Should not throw on valid
      expect(() => assertBookingTransition('AWAITING_PAYMENT', 'CONFIRMED')).not.toThrow();
      expect(() => assertBookingTransition('AWAITING_PAYMENT', 'EXPIRED')).not.toThrow();

      // Should throw on forbidden CANCELLED transition
      expect(() => assertBookingTransition('AWAITING_PAYMENT', 'CANCELLED')).toThrowError(AppError);
    });

    it('allows valid transitions from CONFIRMED', () => {
      expect(canTransitionBooking('CONFIRMED', 'CANCELLED')).toBe(true);
      expect(() => assertBookingTransition('CONFIRMED', 'CANCELLED')).not.toThrow();
    });

    it('forbids invalid transitions from CONFIRMED to AWAITING_PAYMENT or EXPIRED', () => {
      expect(canTransitionBooking('CONFIRMED', 'AWAITING_PAYMENT')).toBe(false);
      expect(canTransitionBooking('CONFIRMED', 'EXPIRED')).toBe(false);

      expect(() => assertBookingTransition('CONFIRMED', 'AWAITING_PAYMENT')).toThrowError(AppError);
      expect(() => assertBookingTransition('CONFIRMED', 'EXPIRED')).toThrowError(AppError);
    });

    it('forbids ANY transition out of CANCELLED (terminal void)', () => {
      const targets: BookingStatus[] = ['AWAITING_PAYMENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED'];
      for (const target of targets) {
        expect(canTransitionBooking('CANCELLED', target)).toBe(false);
        expect(() => assertBookingTransition('CANCELLED', target)).toThrowError(AppError);
      }
    });

    it('forbids ANY transition out of EXPIRED (terminal dead, no resurrection on late payment)', () => {
      const targets: BookingStatus[] = ['AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED'];
      for (const target of targets) {
        expect(canTransitionBooking('EXPIRED', target)).toBe(false);
        expect(() => assertBookingTransition('EXPIRED', target)).toThrowError(AppError);
      }
    });

    it('forbids self-transitions for all states', () => {
      for (const status of BOOKING_STATUSES) {
        expect(canTransitionBooking(status, status)).toBe(false);
      }
    });

    it('throws AppError with BOOKING_INVALID_STATE code on invalid transition', () => {
      try {
        assertBookingTransition('EXPIRED', 'CONFIRMED');
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AppError);
        const appErr = err as AppError;
        expect(appErr.statusCode).toBe(400);
        expect(appErr.code).toBe(ErrorCodes.BOOKING_INVALID_STATE);
        expect(appErr.message).toContain(
          'Invalid booking state transition from EXPIRED to CONFIRMED',
        );
      }
    });
  });

  describe('Terminal Status Identification', () => {
    it('identifies CANCELLED and EXPIRED as terminal states', () => {
      expect(isTerminalBookingStatus('CANCELLED')).toBe(true);
      expect(isTerminalBookingStatus('EXPIRED')).toBe(true);
    });

    it('identifies AWAITING_PAYMENT and CONFIRMED as non-terminal states', () => {
      expect(isTerminalBookingStatus('AWAITING_PAYMENT')).toBe(false);
      expect(isTerminalBookingStatus('CONFIRMED')).toBe(false);
    });
  });

  describe('Exhaustive Transition Matrix Completeness', () => {
    it('has explicit entries for all defined BookingStatus values', () => {
      for (const status of BOOKING_STATUSES) {
        expect(VALID_BOOKING_TRANSITIONS).toHaveProperty(status);
        expect(Array.isArray(VALID_BOOKING_TRANSITIONS[status])).toBe(true);
      }
    });
  });
});
