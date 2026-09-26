import { escapeHtml, formatPrice, formatDuration } from '../utils/formatters.js';
import { api } from '../api/client.js';

/**
 * Controller for viewing single Booking Details and managing Cancellation.
 */
export class BookingDetailModal {
  static currentBooking = null;
  static holdTimerInterval = null;

  static getContainer() {
    return document.getElementById('booking-detail-modal');
  }

  /**
   * Open modal and load booking by reference
   * @param {string} reference
   */
  static async open(reference) {
    const container = this.getContainer();
    if (!container || !reference) return;

    this.clearIntervals();
    container.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    container.innerHTML = `
      <div class="modal-card detail-modal-card" role="document">
        <button type="button" class="modal-close-btn" id="detail-modal-close" aria-label="Close booking details">&times;</button>
        <div class="booking-modal-body">
          <div class="departures-loading-spinner">
            <span class="spinner-icon">🔄</span> Loading booking details...
          </div>
        </div>
      </div>
    `;

    container.querySelector('#detail-modal-close')?.addEventListener('click', () => this.close());

    try {
      const response = await api.getBookingByReference(reference);
      const booking = response?.data || response;
      this.currentBooking = booking;
      this.renderBooking(booking);
    } catch (err) {
      container.innerHTML = `
        <div class="modal-card detail-modal-card" role="document">
          <button type="button" class="modal-close-btn" id="detail-modal-close" aria-label="Close booking details">&times;</button>
          <div class="booking-modal-body">
            <div class="party-alert-box party-alert-warning">
              <span>⚠️ Failed to load booking details: ${escapeHtml(err.message || 'Booking not found')}</span>
            </div>
            <div style="text-align: center; margin-top: 1.5rem;">
              <button type="button" class="btn-secondary" id="btn-close-error">Close</button>
            </div>
          </div>
        </div>
      `;
      container.querySelector('#detail-modal-close')?.addEventListener('click', () => this.close());
      container.querySelector('#btn-close-error')?.addEventListener('click', () => this.close());
    }
  }

  static clearIntervals() {
    if (this.holdTimerInterval) {
      clearInterval(this.holdTimerInterval);
      this.holdTimerInterval = null;
    }
  }

  /**
   * Render loaded booking details
   * @param {object} booking
   */
  static renderBooking(booking) {
    const container = this.getContainer();
    if (!container) return;

    const ref = escapeHtml(booking.bookingReference);
    const status = booking.status;
    const pkg = booking.packageSnapshot || {};
    const dep = booking.departureSnapshot || {};
    const primary = booking.primaryContact || {};
    const roster = Array.isArray(booking.passengers) ? booking.passengers : [];
    const totalPrice = formatPrice(booking.totalPrice, booking.currency);
    const duration = formatDuration(pkg.durationDays, pkg.durationNights);

    let statusBadgeClass = 'badge-warning';
    let statusLabel = status;
    if (status === 'CONFIRMED') {
      statusBadgeClass = 'badge-available';
    } else if (status === 'CANCELLED') {
      statusBadgeClass = 'badge-cancelled';
    } else if (status === 'EXPIRED') {
      statusBadgeClass = 'badge-sold-out';
    }

    const isConfirmed = status === 'CONFIRMED';
    const isAwaitingPayment = status === 'AWAITING_PAYMENT';

    container.innerHTML = `
      <div class="modal-card detail-modal-card" role="document">
        <button type="button" class="modal-close-btn" id="detail-modal-close" aria-label="Close booking details">&times;</button>
        
        <div class="booking-modal-header">
          <div class="booking-header-top-row">
            <span class="badge ${statusBadgeClass}" id="detail-status-badge">${statusLabel}</span>
            <span class="booking-ref-text">Ref: <strong>${ref}</strong></span>
          </div>
          <h2 class="booking-header-title">${escapeHtml(pkg.title || 'Tour Package')}</h2>
          <div class="booking-header-dates">
            <span>⏱️ ${duration} | 📍 ${escapeHtml(pkg.destinationCity || 'India')}, ${escapeHtml(pkg.destinationCountry || 'India')}</span>
          </div>
        </div>

        <div class="booking-modal-body">
          <!-- Notification Alert Container -->
          <div id="detail-alert-box" class="party-alert-box hidden" role="alert"></div>

          ${
            isAwaitingPayment && booking.holdExpiresAt
              ? `
            <div class="hold-countdown-banner">
              <div class="countdown-icon" aria-hidden="true">⏳</div>
              <div class="countdown-content">
                <span class="countdown-label">15-Minute Reservation Hold Active:</span>
                <span class="countdown-timer" id="detail-hold-timer">Calculating remaining hold...</span>
              </div>
            </div>
          `
              : ''
          }

          <!-- Schedule & Summary -->
          <div class="booking-section">
            <h4 class="booking-section-title">Trip Schedule</h4>
            <div class="summary-details-grid">
              <div><strong>Departure Date:</strong> ${escapeHtml(dep.departureDate || 'N/A')}</div>
              <div><strong>Return Date:</strong> ${escapeHtml(dep.returnDate || 'N/A')}</div>
              <div><strong>Total Party:</strong> ${booking.partySize} (${booking.adultCount} Adults, ${booking.childCount} Children)</div>
              <div><strong>Primary Contact:</strong> ${escapeHtml(primary.name)} (${escapeHtml(primary.email)}, ${escapeHtml(primary.phone)})</div>
            </div>
          </div>

          <!-- Passenger Roster Table -->
          <div class="booking-section">
            <h4 class="booking-section-title">Passenger Details</h4>
            <div class="passenger-details-table-wrap">
              <table class="passenger-details-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Age</th>
                    <th>Gender</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  ${roster
                    .map(
                      (p, idx) => `
                    <tr>
                      <td>${idx + 1}</td>
                      <td><strong>${escapeHtml(p.fullName)}</strong></td>
                      <td>${p.passengerType === 'ADULT' ? 'Adult' : 'Child'}</td>
                      <td>${p.ageAtBooking}</td>
                      <td>${escapeHtml(p.gender)}</td>
                      <td>${p.isPrimaryContact ? '<span class="chip chip-sm chip-tier">Primary Contact</span>' : 'Traveller'}</td>
                    </tr>
                  `,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Pricing Breakdown -->
          <div class="booking-section">
            <h4 class="booking-section-title">Financial Summary</h4>
            <div class="price-breakdown-card">
              <div class="ref-row">
                <span>Adults (${booking.adultCount} &times; ${formatPrice(booking.priceBreakdown?.adultUnitPrice || dep.pricingApplied?.basePriceAdult || 0, booking.currency)}):</span>
                <span>${formatPrice(booking.priceBreakdown?.adultSubtotal || 0, booking.currency)}</span>
              </div>
              ${
                booking.childCount > 0
                  ? `
                <div class="ref-row">
                  <span>Children (${booking.childCount} &times; ${formatPrice(booking.priceBreakdown?.childUnitPrice || dep.pricingApplied?.basePriceChild || 0, booking.currency)}):</span>
                  <span>${formatPrice(booking.priceBreakdown?.childSubtotal || 0, booking.currency)}</span>
                </div>
              `
                  : ''
              }
              <div class="ref-row grand-total-row">
                <strong>Total Amount:</strong>
                <strong class="ref-price">${totalPrice}</strong>
              </div>
            </div>
          </div>

          ${
            booking.cancellationReason
              ? `
            <div class="booking-section">
              <div class="party-alert-box party-alert-warning">
                <strong>Cancellation Reason:</strong> ${escapeHtml(booking.cancellationReason)}
              </div>
            </div>
          `
              : ''
          }
        </div>

        <div class="booking-modal-footer">
          ${
            isConfirmed
              ? `<button type="button" class="btn-danger" id="btn-trigger-cancel">Cancel Reservation</button>`
              : ''
          }
          <button type="button" class="btn-primary" id="btn-close-detail">Close</button>
        </div>
      </div>
    `;

    // Start timer if awaiting payment
    if (isAwaitingPayment && booking.holdExpiresAt) {
      const expiresAt = new Date(booking.holdExpiresAt).getTime();
      const updateTimer = () => {
        const display = document.getElementById('detail-hold-timer');
        if (!display) return;
        const rem = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
        if (rem <= 0) {
          display.innerHTML = '<span class="timer-expired">Hold Expired</span>';
          this.clearIntervals();
          return;
        }
        const m = Math.floor(rem / 60);
        const s = rem % 60;
        display.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} remaining to confirm`;
      };
      updateTimer();
      this.holdTimerInterval = setInterval(updateTimer, 1000);
    }

    // Event listeners
    container.querySelector('#detail-modal-close')?.addEventListener('click', () => this.close());
    container.querySelector('#btn-close-detail')?.addEventListener('click', () => this.close());

    const cancelBtn = container.querySelector('#btn-trigger-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.handleCancellation(booking.bookingReference));
    }
  }

  /**
   * Handle cancellation of a CONFIRMED booking
   * @param {string} reference
   */
  static async handleCancellation(reference) {
    const reason = window.prompt(
      'Are you sure you want to cancel this booking? Please provide a reason:',
      'Schedule conflict',
    );
    if (!reason || reason.trim().length === 0) {
      return;
    }

    const alertBox = document.getElementById('detail-alert-box');
    const cancelBtn = document.getElementById('btn-trigger-cancel');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Processing Cancellation...';
    }

    try {
      const response = await api.cancelBooking(reference, reason.trim());
      const updated = response?.data || response;
      this.currentBooking = updated;
      this.renderBooking(updated);
    } catch (err) {
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel Reservation';
      }
      if (alertBox) {
        alertBox.className = 'party-alert-box party-alert-warning';
        alertBox.innerHTML = `<span>⚠️ ${escapeHtml(err.message || 'Failed to cancel booking')}</span>`;
        alertBox.classList.remove('hidden');
      }
    }
  }

  static close() {
    this.clearIntervals();
    const container = this.getContainer();
    if (container) {
      container.classList.add('hidden');
      container.innerHTML = '';
      document.body.style.overflow = '';
    }
  }
}
