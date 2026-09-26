import { escapeHtml, formatPrice } from '../utils/formatters.js';
import { api } from '../api/client.js';
import { authStore } from '../state/auth.js';
import { AuthModal } from './authModal.js';
import { MyBookingsModal } from './myBookingsModal.js';
import { BookingDetailModal } from './bookingDetailModal.js';

/**
 * Controller for the Customer Booking & Checkout Modal.
 *
 * Invariants & Boundaries:
 * - Collects traveler roster: `partySize = adultCount + childCount` (partySize >= 1).
 * - Primary contact must be defined with valid name, email, and phone.
 * - Never sends client-controlled `customerId`, `totalPrice`, `status`, or `holdId`.
 * - Emits client-generated RFC4122 `idempotency-key` with duplicate submission prevention.
 * - Displays server-authoritative `AWAITING_PAYMENT` state with live 15-minute hold timer.
 * - Strict Phase 6 boundary: Payment is NOT implemented; displays payment pending state honestly.
 */
export class BookingModal {
  static currentContext = null;
  static adultCount = 1;
  static childCount = 0;
  static passengers = [];
  static primaryContact = { name: '', email: '', phone: '' };
  static specialRequests = '';
  static isSubmitting = false;
  static idempotencyKey = null;
  static holdTimerInterval = null;
  static savedPendingBooking = null;

  static getContainer() {
    return document.getElementById('booking-modal');
  }

  /**
   * Initialize component hooks (e.g. AuthStore resume subscription)
   */
  static init() {
    authStore.subscribe((state) => {
      // If user just authenticated and had a pending booking draft, resume checkout
      if (state.isAuthenticated && this.savedPendingBooking) {
        const pending = this.savedPendingBooking;
        this.savedPendingBooking = null;
        this.open(pending);
      }
    });
  }

  /**
   * Open booking checkout modal for a package and departure
   * @param {{ pkg: object, departure: object, initialPartySize?: number }} context
   */
  static open(context) {
    if (!context || !context.pkg || !context.departure) {
      return;
    }

    this.currentContext = context;
    const initialTotal = Math.max(1, Number(context.initialPartySize) || 1);
    this.adultCount = initialTotal;
    this.childCount = 0;
    this.specialRequests = '';
    this.isSubmitting = false;
    this.idempotencyKey = null;
    this.clearIntervals();

    // Auto-populate primary contact if user is authenticated
    const currentUser = authStore.getUser();
    if (currentUser) {
      this.primaryContact = {
        name: currentUser.fullName || '',
        email: currentUser.email || '',
        phone: this.primaryContact?.phone || '',
      };
    } else {
      this.primaryContact = { name: '', email: '', phone: '' };
    }

    this.syncPassengerRoster();
    this.renderWizard();

    const container = this.getContainer();
    if (container) {
      container.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    }
  }

  static clearIntervals() {
    if (this.holdTimerInterval) {
      clearInterval(this.holdTimerInterval);
      this.holdTimerInterval = null;
    }
  }

  /**
   * Synchronize the passenger roster array to match adultCount + childCount
   */
  static syncPassengerRoster() {
    const newRoster = [];

    // Existing passengers preserve values where possible
    const existingAdults = this.passengers.filter((p) => p.passengerType === 'ADULT');
    const existingChildren = this.passengers.filter((p) => p.passengerType === 'CHILD');

    for (let i = 0; i < this.adultCount; i++) {
      const existing = existingAdults[i];
      newRoster.push({
        passengerType: 'ADULT',
        fullName: existing?.fullName || (i === 0 ? this.primaryContact.name : ''),
        ageAtBooking: existing?.ageAtBooking ?? 30,
        gender: existing?.gender || 'MALE',
        isPrimaryContact: i === 0,
      });
    }

    for (let i = 0; i < this.childCount; i++) {
      const existing = existingChildren[i];
      newRoster.push({
        passengerType: 'CHILD',
        fullName: existing?.fullName || '',
        ageAtBooking: existing?.ageAtBooking ?? 8,
        gender: existing?.gender || 'FEMALE',
        isPrimaryContact: false,
      });
    }

    // Ensure exactly one primary contact is selected
    const hasPrimary = newRoster.some((p) => p.isPrimaryContact);
    if (!hasPrimary && newRoster.length > 0) {
      newRoster[0].isPrimaryContact = true;
    }

    this.passengers = newRoster;
  }

  /**
   * Render the main booking intake wizard
   */
  static renderWizard() {
    const container = this.getContainer();
    if (!container || !this.currentContext) return;

    const { pkg, departure } = this.currentContext;
    const pkgTitle = escapeHtml(pkg.title);
    const depDate = escapeHtml(departure.departureDate);
    const retDate = escapeHtml(departure.returnDate);
    const currency = departure.currency || pkg.currency || 'INR';
    const adultUnitPrice = departure.effectiveAdultPrice || pkg.baseAdultPrice || 0;
    const childUnitPrice = departure.effectiveChildPrice || pkg.baseChildPrice || 0;

    const partySize = this.adultCount + this.childCount;
    const estimatedSubtotal = this.adultCount * adultUnitPrice + this.childCount * childUnitPrice;

    container.innerHTML = `
      <div class="modal-card booking-modal-card" role="document">
        <button type="button" class="modal-close-btn" id="booking-modal-close" aria-label="Close booking checkout">&times;</button>
        
        <div class="booking-modal-header">
          <div class="booking-header-badge">Step 1 of 2: Traveller Details</div>
          <h2 class="booking-header-title">Book Tour: ${pkgTitle}</h2>
          <div class="booking-header-dates">
            <span>📅 <strong>Departure:</strong> ${depDate} &rarr; <strong>Return:</strong> ${retDate}</span>
          </div>
        </div>

        <div class="booking-modal-body">
          <!-- Notification Alert Container -->
          <div id="booking-alert-box" class="party-alert-box hidden" role="alert"></div>

          <!-- Section 1: Party Size Configuration -->
          <div class="booking-section">
            <h3 class="booking-section-title">1. Select Party Configuration</h3>
            <div class="party-config-grid">
              <div class="party-config-card">
                <div class="party-config-info">
                  <span class="party-type-label">Adults (Age 12+)</span>
                  <span class="party-type-price">${formatPrice(adultUnitPrice, currency)} / person</span>
                </div>
                <div class="party-size-stepper">
                  <button type="button" class="btn-stepper" id="step-adult-dec" aria-label="Decrease adults">-</button>
                  <span class="stepper-val" id="step-adult-val">${this.adultCount}</span>
                  <button type="button" class="btn-stepper" id="step-adult-inc" aria-label="Increase adults">+</button>
                </div>
              </div>

              <div class="party-config-card">
                <div class="party-config-info">
                  <span class="party-type-label">Children (Age 0-11)</span>
                  <span class="party-type-price">${formatPrice(childUnitPrice, currency)} / person</span>
                </div>
                <div class="party-size-stepper">
                  <button type="button" class="btn-stepper" id="step-child-dec" aria-label="Decrease children">-</button>
                  <span class="stepper-val" id="step-child-val">${this.childCount}</span>
                  <button type="button" class="btn-stepper" id="step-child-inc" aria-label="Increase children">+</button>
                </div>
              </div>
            </div>
            <div class="party-total-summary">
              Total Party Size: <strong>${partySize} traveller${partySize === 1 ? '' : 's'}</strong>
            </div>
          </div>

          <!-- Section 2: Traveller Roster Form -->
          <div class="booking-section">
            <h3 class="booking-section-title">2. Traveller Information</h3>
            <div class="passenger-roster-list" id="passenger-roster-list">
              ${this.renderPassengerForms()}
            </div>
          </div>

          <!-- Section 3: Primary Contact & Special Requests -->
          <div class="booking-section">
            <h3 class="booking-section-title">3. Contact & Special Requests</h3>
            <div class="form-grid-2col">
              <div class="form-group">
                <label for="primary-contact-email" class="form-label">Contact Email *</label>
                <input
                  type="email"
                  id="primary-contact-email"
                  class="form-input"
                  placeholder="name@example.com"
                  value="${escapeHtml(this.primaryContact.email)}"
                  required
                />
              </div>
              <div class="form-group">
                <label for="primary-contact-phone" class="form-label">Contact Phone (with country code) *</label>
                <input
                  type="tel"
                  id="primary-contact-phone"
                  class="form-input"
                  placeholder="+919876543210"
                  value="${escapeHtml(this.primaryContact.phone)}"
                  required
                />
              </div>
            </div>
            <div class="form-group">
              <label for="booking-special-requests" class="form-label">Special Requests (Optional)</label>
              <textarea
                id="booking-special-requests"
                class="form-textarea"
                rows="2"
                placeholder="e.g. Vegetarian meals, ground floor room preference..."
              >${escapeHtml(this.specialRequests)}</textarea>
            </div>
          </div>

          <!-- Section 4: Price & Hold Notice -->
          <div class="booking-summary-banner">
            <div class="summary-price-col">
              <span class="summary-price-label">Estimated Total Price</span>
              <span class="summary-price-value">${formatPrice(estimatedSubtotal, currency)}</span>
              <span class="summary-price-note">Authoritative price will be verified and locked by backend</span>
            </div>
            <div class="summary-hold-notice">
              <span class="notice-icon" aria-hidden="true">⏱️</span>
              <span>Submitting creates an <strong>instant 15-minute hold</strong> on inventory.</span>
            </div>
          </div>
        </div>

        <div class="booking-modal-footer">
          <button type="button" class="btn-secondary" id="btn-cancel-booking">Cancel</button>
          <button type="button" class="btn-primary btn-submit-booking" id="btn-submit-booking">
            <span class="btn-text">Confirm & Reserve Seats &rarr;</span>
          </button>
        </div>
      </div>
    `;

    this.attachWizardListeners();
  }

  /**
   * Render individual passenger forms
   */
  static renderPassengerForms() {
    return this.passengers
      .map((passenger, index) => {
        const isAdult = passenger.passengerType === 'ADULT';
        const typeBadge = isAdult
          ? '<span class="badge badge-theme">Adult</span>'
          : '<span class="badge badge-duration">Child</span>';
        const fullName = escapeHtml(passenger.fullName);
        const age = Number(passenger.ageAtBooking);

        return `
          <div class="passenger-card" data-passenger-index="${index}">
            <div class="passenger-card-header">
              <div class="passenger-header-left">
                <span class="passenger-number">Traveller ${index + 1}</span>
                ${typeBadge}
              </div>
              <label class="primary-contact-toggle">
                <input
                  type="radio"
                  name="primaryContactRadio"
                  value="${index}"
                  ${passenger.isPrimaryContact ? 'checked' : ''}
                  data-index="${index}"
                />
                <span>Primary Contact</span>
              </label>
            </div>
            <div class="passenger-form-row">
              <div class="form-group flex-2">
                <label class="form-label">Full Name *</label>
                <input
                  type="text"
                  class="form-input passenger-name-input"
                  data-field="fullName"
                  data-index="${index}"
                  placeholder="As on passport / ID"
                  value="${fullName}"
                  required
                />
              </div>
              <div class="form-group flex-1">
                <label class="form-label">Age *</label>
                <input
                  type="number"
                  class="form-input passenger-age-input"
                  data-field="ageAtBooking"
                  data-index="${index}"
                  min="${isAdult ? 12 : 0}"
                  max="${isAdult ? 120 : 11}"
                  value="${age}"
                  required
                />
              </div>
              <div class="form-group flex-1">
                <label class="form-label">Gender *</label>
                <select class="form-select passenger-gender-select" data-field="gender" data-index="${index}">
                  <option value="MALE" ${passenger.gender === 'MALE' ? 'selected' : ''}>Male</option>
                  <option value="FEMALE" ${passenger.gender === 'FEMALE' ? 'selected' : ''}>Female</option>
                  <option value="OTHER" ${passenger.gender === 'OTHER' ? 'selected' : ''}>Other</option>
                </select>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  /**
   * Attach interactive listeners to wizard elements
   */
  static attachWizardListeners() {
    const container = this.getContainer();
    if (!container) return;

    // Close button
    container.querySelector('#booking-modal-close')?.addEventListener('click', () => this.close());
    container.querySelector('#btn-cancel-booking')?.addEventListener('click', () => this.close());

    // Adult steppers
    container.querySelector('#step-adult-dec')?.addEventListener('click', () => {
      if (this.adultCount > 1) {
        this.adultCount--;
        this.syncPassengerRoster();
        this.renderWizard();
      }
    });
    container.querySelector('#step-adult-inc')?.addEventListener('click', () => {
      if (this.adultCount + this.childCount < 20) {
        this.adultCount++;
        this.syncPassengerRoster();
        this.renderWizard();
      }
    });

    // Child steppers
    container.querySelector('#step-child-dec')?.addEventListener('click', () => {
      if (this.childCount > 0) {
        this.childCount--;
        this.syncPassengerRoster();
        this.renderWizard();
      }
    });
    container.querySelector('#step-child-inc')?.addEventListener('click', () => {
      if (this.adultCount + this.childCount < 20) {
        this.childCount++;
        this.syncPassengerRoster();
        this.renderWizard();
      }
    });

    // Passenger input tracking
    container.querySelectorAll('.passenger-name-input').forEach((input) => {
      input.addEventListener('input', (e) => {
        const idx = Number(e.target.getAttribute('data-index'));
        if (this.passengers[idx]) {
          this.passengers[idx].fullName = e.target.value;
          if (this.passengers[idx].isPrimaryContact) {
            this.primaryContact.name = e.target.value;
          }
        }
      });
    });

    container.querySelectorAll('.passenger-age-input').forEach((input) => {
      input.addEventListener('change', (e) => {
        const idx = Number(e.target.getAttribute('data-index'));
        if (this.passengers[idx]) {
          this.passengers[idx].ageAtBooking = Number(e.target.value) || 0;
        }
      });
    });

    container.querySelectorAll('.passenger-gender-select').forEach((select) => {
      select.addEventListener('change', (e) => {
        const idx = Number(e.target.getAttribute('data-index'));
        if (this.passengers[idx]) {
          this.passengers[idx].gender = e.target.value;
        }
      });
    });

    // Primary contact radio buttons
    container.querySelectorAll('input[name="primaryContactRadio"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        const selectedIdx = Number(e.target.value);
        this.passengers.forEach((p, idx) => {
          p.isPrimaryContact = idx === selectedIdx;
        });
        if (this.passengers[selectedIdx]) {
          this.primaryContact.name = this.passengers[selectedIdx].fullName;
        }
      });
    });

    // Primary email & phone
    const emailInput = container.querySelector('#primary-contact-email');
    emailInput?.addEventListener('input', (e) => {
      this.primaryContact.email = e.target.value.trim();
    });

    const phoneInput = container.querySelector('#primary-contact-phone');
    phoneInput?.addEventListener('input', (e) => {
      this.primaryContact.phone = e.target.value.trim();
    });

    // Special requests
    const specialInput = container.querySelector('#booking-special-requests');
    specialInput?.addEventListener('input', (e) => {
      this.specialRequests = e.target.value;
    });

    // Submit button
    const submitBtn = container.querySelector('#btn-submit-booking');
    submitBtn?.addEventListener('click', () => this.handleBookingSubmit());
  }

  /**
   * Validate and submit booking request to backend API
   */
  static async handleBookingSubmit() {
    if (this.isSubmitting) return;

    const alertBox = document.getElementById('booking-alert-box');
    const submitBtn = document.getElementById('btn-submit-booking');

    // 1. Check Authentication Guard
    if (!authStore.isAuthenticated()) {
      // Save draft context and prompt login
      this.savedPendingBooking = {
        ...this.currentContext,
        initialPartySize: this.adultCount + this.childCount,
      };
      if (alertBox) {
        alertBox.className = 'party-alert-box party-alert-warning';
        alertBox.innerHTML = `<span>⚠️ Please log in to complete your booking. Your details have been preserved.</span>`;
        alertBox.classList.remove('hidden');
      }
      AuthModal.open('login');
      return;
    }

    // 2. Client-side Form Validation
    const partySize = this.adultCount + this.childCount;
    if (partySize < 1) {
      this.showAlert('Party size must be at least 1 traveller.', 'warning');
      return;
    }

    if (this.passengers.length !== partySize) {
      this.showAlert('Passenger roster count must match total party size.', 'warning');
      return;
    }

    // Validate passenger details
    for (let i = 0; i < this.passengers.length; i++) {
      const p = this.passengers[i];
      if (!p.fullName || p.fullName.trim().length < 2) {
        this.showAlert(`Please enter a valid full name for Traveller ${i + 1}.`, 'warning');
        return;
      }
      if (p.passengerType === 'ADULT' && (p.ageAtBooking < 12 || p.ageAtBooking > 120)) {
        this.showAlert(
          `Traveller ${i + 1} is listed as an Adult but age must be 12-120.`,
          'warning',
        );
        return;
      }
      if (p.passengerType === 'CHILD' && (p.ageAtBooking < 0 || p.ageAtBooking > 11)) {
        this.showAlert(`Traveller ${i + 1} is listed as a Child but age must be 0-11.`, 'warning');
        return;
      }
    }

    // Validate primary contact
    if (!this.primaryContact.name || this.primaryContact.name.trim().length < 2) {
      const primary = this.passengers.find((p) => p.isPrimaryContact) || this.passengers[0];
      this.primaryContact.name = primary?.fullName || 'Primary Contact';
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!this.primaryContact.email || !emailRegex.test(this.primaryContact.email)) {
      this.showAlert('Please provide a valid contact email address.', 'warning');
      return;
    }

    const phoneRegex = /^\+?[1-9]\d{6,14}$/;
    if (!this.primaryContact.phone || !phoneRegex.test(this.primaryContact.phone)) {
      this.showAlert(
        'Please provide a valid contact phone number with country code (e.g. +919876543210).',
        'warning',
      );
      return;
    }

    // 3. Build Safe Payload (Strictly NO client-controlled customerId, totalPrice, status, holdId)
    const payload = {
      departureId: this.currentContext.departure.departureId || this.currentContext.departure.id,
      partySize,
      adultCount: this.adultCount,
      childCount: this.childCount,
      passengers: this.passengers.map((p) => ({
        passengerType: p.passengerType,
        fullName: p.fullName.trim(),
        ageAtBooking: Number(p.ageAtBooking),
        gender: p.gender,
        isPrimaryContact: Boolean(p.isPrimaryContact),
      })),
      primaryContact: {
        name: this.primaryContact.name.trim(),
        email: this.primaryContact.email.trim(),
        phone: this.primaryContact.phone.trim(),
      },
      ...(this.specialRequests ? { specialRequests: this.specialRequests.trim() } : {}),
    };

    // 4. Submit via ApiClient with Idempotency Key & in-flight lock
    this.isSubmitting = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span class="spinner-icon">🔄</span> Creating your booking...`;
    }

    // Maintain stable idempotency key for this creation attempt
    if (!this.idempotencyKey) {
      this.idempotencyKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
              const r = (Math.random() * 16) | 0;
              const v = c === 'x' ? r : (r & 0x3) | 0x8;
              return v.toString(16);
            });
    }

    try {
      const response = await api.createBooking(payload, this.idempotencyKey);
      const booking = response?.data || response;
      this.isSubmitting = false;

      // Render Confirmation / Awaiting Payment view
      this.renderConfirmation(booking);
    } catch (err) {
      this.isSubmitting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<span class="btn-text">Confirm & Reserve Seats &rarr;</span>`;
      }

      let errorMsg = err.message || 'Unable to create booking. Please try again.';
      if (err.code === 'INVENTORY_CAPACITY_EXCEEDED') {
        errorMsg =
          'Sorry, the selected seats are no longer available. Please choose another departure date or reduce your party size.';
      } else if (err.code === 'IDEMPOTENCY_CONFLICT') {
        errorMsg =
          'A conflicting booking request was detected with this key. Please refresh and try again.';
      }

      this.showAlert(errorMsg, 'warning');
    }
  }

  /**
   * Render Confirmation / Awaiting Payment State
   * @param {object} booking
   */
  static renderConfirmation(booking) {
    const container = this.getContainer();
    if (!container) return;

    const bookingRef = escapeHtml(booking.bookingReference);
    const totalPrice = formatPrice(booking.totalPrice, booking.currency);
    const partySize = Number(booking.partySize);
    const pkgTitle = escapeHtml(
      booking.packageSnapshot?.title || this.currentContext?.pkg?.title || 'Tour Package',
    );
    const depDate = escapeHtml(
      booking.departureSnapshot?.departureDate ||
        this.currentContext?.departure?.departureDate ||
        '',
    );
    const retDate = escapeHtml(
      booking.departureSnapshot?.returnDate || this.currentContext?.departure?.returnDate || '',
    );

    container.innerHTML = `
      <div class="modal-card booking-modal-card" role="document">
        <button type="button" class="modal-close-btn" id="booking-modal-close" aria-label="Close booking checkout">&times;</button>
        
        <div class="booking-confirmation-header">
          <div class="confirmation-icon" aria-hidden="true">🎉</div>
          <h2 class="confirmation-title">Booking Created & Seats Held!</h2>
          <p class="confirmation-subtitle">Your reservation has been created and inventory is locked.</p>
        </div>

        <div class="booking-modal-body">
          <!-- 15-Minute Hold Countdown Banner -->
          <div class="hold-countdown-banner" id="hold-countdown-banner">
            <div class="countdown-icon" aria-hidden="true">⏳</div>
            <div class="countdown-content">
              <span class="countdown-label">15-Minute Inventory Hold Active:</span>
              <span class="countdown-timer" id="hold-timer-display">Calculating time remaining...</span>
            </div>
          </div>

          <!-- Status & Reference Card -->
          <div class="booking-ref-card">
            <div class="ref-row">
              <span class="ref-label">Booking Reference:</span>
              <span class="ref-value" id="confirmation-booking-ref">${bookingRef}</span>
            </div>
            <div class="ref-row">
              <span class="ref-label">Booking Status:</span>
              <span class="badge badge-warning" id="confirmation-status-badge">AWAITING_PAYMENT</span>
            </div>
            <div class="ref-row">
              <span class="ref-label">Locked Total Amount:</span>
              <span class="ref-price">${totalPrice}</span>
            </div>
          </div>

          <!-- Summary Snapshot Card -->
          <div class="booking-section">
            <h4 class="booking-section-title">Reservation Summary</h4>
            <div class="summary-details-grid">
              <div><strong>Package:</strong> ${pkgTitle}</div>
              <div><strong>Departure:</strong> ${depDate} &rarr; ${retDate}</div>
              <div><strong>Party Size:</strong> ${partySize} Traveller${partySize === 1 ? '' : 's'} (${booking.adultCount} Adults, ${booking.childCount} Children)</div>
              <div><strong>Primary Contact:</strong> ${escapeHtml(booking.primaryContact?.name)} (${escapeHtml(booking.primaryContact?.email)})</div>
            </div>
          </div>

          <!-- Phase 6 Payment Honest Notice -->
          <div class="phase6-payment-notice">
            <div class="notice-title">💳 Next Step: Payment Confirmation</div>
            <p>
              Your booking is currently in <strong>AWAITING_PAYMENT</strong> status. Complete payment within the hold window to receive an official booking confirmation.
            </p>
            <p class="text-muted text-sm">
              <em>Note: Payment gateway integration (Razorpay / Stripe) will be available in Phase 6.</em>
            </p>
          </div>
        </div>

        <div class="booking-modal-footer">
          <button type="button" class="btn-secondary" id="btn-view-my-bookings">View in My Bookings</button>
          <button type="button" class="btn-primary" id="btn-booking-done">Done</button>
        </div>
      </div>
    `;

    // Start 15-minute hold timer countdown
    const expiresAt = booking.holdExpiresAt
      ? new Date(booking.holdExpiresAt).getTime()
      : Date.now() + 15 * 60 * 1000;
    this.startHoldCountdown(expiresAt);

    // Attach confirmation listeners
    container.querySelector('#booking-modal-close')?.addEventListener('click', () => this.close());
    container.querySelector('#btn-booking-done')?.addEventListener('click', () => this.close());
    container.querySelector('#btn-view-my-bookings')?.addEventListener('click', () => {
      this.close();
      MyBookingsModal.open();
    });
  }

  /**
   * Start live hold countdown timer
   * @param {number} expiresAtMs
   */
  static startHoldCountdown(expiresAtMs) {
    this.clearIntervals();

    const updateTimer = () => {
      const display = document.getElementById('hold-timer-display');
      if (!display) return;

      const remainingSec = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
      if (remainingSec <= 0) {
        display.innerHTML =
          '<span class="timer-expired">Hold Expired. Please create a new booking.</span>';
        this.clearIntervals();
        return;
      }

      const minutes = Math.floor(remainingSec / 60);
      const seconds = remainingSec % 60;
      display.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} remaining to confirm`;
    };

    updateTimer();
    this.holdTimerInterval = setInterval(updateTimer, 1000);
  }

  static showAlert(message, type = 'warning') {
    const alertBox = document.getElementById('booking-alert-box');
    if (!alertBox) return;

    alertBox.className = `party-alert-box party-alert-${type}`;
    alertBox.innerHTML = `<span>${escapeHtml(message)}</span>`;
    alertBox.classList.remove('hidden');
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
