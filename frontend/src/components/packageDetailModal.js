import { escapeHtml, formatPrice, formatDuration, FALLBACK_IMAGE } from '../utils/formatters.js';
import { api } from '../api/client.js';
import { BookingModal } from './bookingModal.js';

/**
 * Controller for rendering and handling the Package Detail Modal with Phase 4 Live Departures & Availability
 */
export class PackageDetailModal {
  static currentPackage = null;
  static departures = [];
  static selectedDepartureId = null;
  static partySize = 1;
  static loadingDepartures = false;

  static getContainer() {
    return document.getElementById('package-detail-modal');
  }

  /**
   * Open modal and render package details + live departure schedules
   * @param {object} pkg - Full TourPackageDetailDto
   */
  static async open(pkg) {
    const container = this.getContainer();
    if (!container) return;

    this.currentPackage = pkg;
    this.departures = [];
    this.selectedDepartureId = null;
    this.partySize = 1;
    this.loadingDepartures = true;

    const title = escapeHtml(pkg.title);
    const shortDesc = escapeHtml(pkg.shortDescription);
    const description = escapeHtml(pkg.description);
    const destinationCity = escapeHtml(pkg.destination?.cityName || pkg.destinationCity || 'India');
    const destinationCountry = escapeHtml(pkg.destination?.country || 'India');
    const themeTitle = pkg.theme?.title ? escapeHtml(pkg.theme.title) : null;
    const duration = formatDuration(pkg.durationDays, pkg.durationNights);
    const heroImage = pkg.heroImageUrl ? escapeHtml(pkg.heroImageUrl) : FALLBACK_IMAGE;
    const adultPrice = formatPrice(pkg.baseAdultPrice, pkg.currency);
    const childPrice =
      pkg.baseChildPrice && pkg.baseChildPrice > 0
        ? formatPrice(pkg.baseChildPrice, pkg.currency)
        : null;

    // Gallery images
    const gallery = Array.isArray(pkg.galleryUrls) ? pkg.galleryUrls : [];
    const galleryHtml =
      gallery.length > 0
        ? `
        <div class="detail-section">
          <h4 class="detail-subtitle">Photo Gallery</h4>
          <div class="detail-gallery-grid">
            ${gallery
              .map(
                (url, idx) => `
              <div class="gallery-thumb-container">
                <img
                  src="${escapeHtml(url)}"
                  alt="${title} gallery photo ${idx + 1}"
                  class="gallery-thumb"
                  loading="lazy"
                  onerror="this.onerror=null; this.src='${FALLBACK_IMAGE}';"
                />
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
      `
        : '';

    // Inclusions
    const inclusions = Array.isArray(pkg.inclusions) ? pkg.inclusions : [];
    const inclusionsHtml =
      inclusions.length > 0
        ? `
        <div class="detail-feature-col">
          <h4 class="detail-subtitle"><span class="icon-check" aria-hidden="true">✓</span> Inclusions</h4>
          <ul class="detail-list inclusion-list">
            ${inclusions.map((item) => `<li><span class="bullet-check">✓</span> ${escapeHtml(item)}</li>`).join('')}
          </ul>
        </div>
      `
        : '';

    // Exclusions
    const exclusions = Array.isArray(pkg.exclusions) ? pkg.exclusions : [];
    const exclusionsHtml =
      exclusions.length > 0
        ? `
        <div class="detail-feature-col">
          <h4 class="detail-subtitle"><span class="icon-cross" aria-hidden="true">✕</span> Exclusions</h4>
          <ul class="detail-list exclusion-list">
            ${exclusions.map((item) => `<li><span class="bullet-cross">✕</span> ${escapeHtml(item)}</li>`).join('')}
          </ul>
        </div>
      `
        : '';

    // Accommodation Tiers & Meal Plans
    const tiers = Array.isArray(pkg.accommodationTiers) ? pkg.accommodationTiers : [];
    const mealPlans = Array.isArray(pkg.mealPlans) ? pkg.mealPlans : [];

    const accommodationHtml =
      tiers.length > 0 || mealPlans.length > 0
        ? `
        <div class="detail-section detail-amenities-section">
          ${
            tiers.length > 0
              ? `
            <div class="amenity-group">
              <span class="amenity-label">Accommodation Tiers:</span>
              <div class="chip-group">
                ${tiers.map((t) => `<span class="chip chip-tier">${escapeHtml(t)}</span>`).join('')}
              </div>
            </div>
          `
              : ''
          }
          ${
            mealPlans.length > 0
              ? `
            <div class="amenity-group">
              <span class="amenity-label">Meal Plans:</span>
              <div class="chip-group">
                ${mealPlans.map((m) => `<span class="chip chip-meal">${escapeHtml(m)}</span>`).join('')}
              </div>
            </div>
          `
              : ''
          }
        </div>
      `
        : '';

    // Day-by-day Itinerary
    const itinerary = Array.isArray(pkg.itinerary) ? pkg.itinerary : [];
    const itineraryHtml =
      itinerary.length > 0
        ? `
        <div class="detail-section detail-itinerary-section">
          <h4 class="detail-subtitle">Day-by-Day Itinerary</h4>
          <div class="itinerary-timeline">
            ${itinerary
              .map(
                (day) => `
              <div class="itinerary-day-item">
                <div class="day-number-badge">Day ${escapeHtml(day.dayNumber)}</div>
                <div class="day-content">
                  <h5 class="day-title">${escapeHtml(day.title)}</h5>
                  <p class="day-activity">${escapeHtml(day.activityDescription)}</p>
                  ${
                    Array.isArray(day.mealsIncluded) && day.mealsIncluded.length > 0
                      ? `
                    <div class="day-meta">
                      <span class="day-meals-label">Meals:</span>
                      ${day.mealsIncluded.map((meal) => `<span class="chip chip-sm">${escapeHtml(meal)}</span>`).join(' ')}
                    </div>
                  `
                      : ''
                  }
                  ${
                    day.accommodationNotes
                      ? `
                    <div class="day-notes">
                      <span class="notes-icon" aria-hidden="true">🏨</span>
                      <span>${escapeHtml(day.accommodationNotes)}</span>
                    </div>
                  `
                      : ''
                  }
                </div>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
      `
        : `
        <div class="detail-section">
          <p class="text-muted">Itinerary details will be updated soon.</p>
        </div>
      `;

    container.innerHTML = `
      <div class="modal-card detail-modal-card" role="document">
        <button type="button" class="modal-close-btn" id="package-modal-close" aria-label="Close package details">&times;</button>
        
        <div class="detail-header-banner" style="background-image: url('${heroImage}');">
          <div class="banner-overlay"></div>
          <div class="banner-content">
            <div class="banner-badges">
              <span class="badge badge-duration">⏱️ ${duration}</span>
              ${themeTitle ? `<span class="badge badge-theme">${themeTitle}</span>` : ''}
              <span class="badge badge-location">📍 ${destinationCity}, ${destinationCountry}</span>
            </div>
            <h2 class="detail-title">${title}</h2>
            <p class="detail-short-desc">${shortDesc}</p>
          </div>
        </div>

        <div class="detail-modal-body">
          <div class="detail-pricing-box">
            <div class="pricing-col">
              <span class="pricing-label">Starting Base Price</span>
              <span class="pricing-amount">${adultPrice}</span>
              <span class="pricing-subtext">per adult</span>
            </div>
            ${
              childPrice
                ? `
              <div class="pricing-col">
                <span class="pricing-label">Child Base Price</span>
                <span class="pricing-amount">${childPrice}</span>
                <span class="pricing-subtext">per child</span>
              </div>
            `
                : ''
            }
          </div>

          <!-- Phase 4 Departures & Live Availability Section -->
          <div class="detail-section detail-departures-section" id="detail-departures-section">
            <div class="departures-header-row">
              <div>
                <h4 class="detail-subtitle">Upcoming Departures & Availability</h4>
                <p class="departures-subtitle-text">Select your preferred travel dates to check real-time seat availability and effective pricing.</p>
              </div>
              
              <!-- Party Size Selector -->
              <div class="party-size-control">
                <label for="party-size-input" class="party-size-label">Party Size:</label>
                <div class="party-size-stepper">
                  <button type="button" class="btn-stepper" id="party-size-dec" aria-label="Decrease party size">-</button>
                  <input
                    type="number"
                    id="party-size-input"
                    class="party-size-input"
                    min="1"
                    max="50"
                    value="1"
                    aria-label="Number of travelers"
                  />
                  <button type="button" class="btn-stepper" id="party-size-inc" aria-label="Increase party size">+</button>
                </div>
              </div>
            </div>

            <!-- Party Availability Alert Notice -->
            <div id="party-availability-alert" class="party-alert-box hidden"></div>

            <!-- Departures List Container -->
            <div class="departures-list" id="departures-list-container">
              <div class="departures-loading-spinner">
                <span class="spinner-icon">🔄</span> Checking live departure schedules...
              </div>
            </div>
          </div>

          <div class="detail-section">
            <h4 class="detail-subtitle">Tour Overview</h4>
            <p class="detail-full-description">${description}</p>
          </div>

          ${galleryHtml}
          ${accommodationHtml}

          ${
            inclusionsHtml || exclusionsHtml
              ? `
            <div class="detail-section detail-grid-2col">
              ${inclusionsHtml}
              ${exclusionsHtml}
            </div>
          `
              : ''
          }

          ${itineraryHtml}
        </div>
      </div>
    `;

    container.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Modal close listeners
    const closeBtn = container.querySelector('#package-modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }

    container.onclick = (e) => {
      if (e.target === container) {
        this.close();
      }
    };

    this.escListener = (e) => {
      if (e.key === 'Escape') {
        this.close();
      }
    };
    window.addEventListener('keydown', this.escListener);

    // Party size stepper listeners
    const partyInput = container.querySelector('#party-size-input');
    const partyDec = container.querySelector('#party-size-dec');
    const partyInc = container.querySelector('#party-size-inc');

    if (partyInput) {
      partyInput.addEventListener('change', () => {
        const val = Math.max(1, Math.min(50, Number(partyInput.value) || 1));
        partyInput.value = String(val);
        this.updatePartySize(val);
      });
    }

    if (partyDec) {
      partyDec.addEventListener('click', () => {
        const current = Number(partyInput?.value || 1);
        if (current > 1) {
          const next = current - 1;
          if (partyInput) partyInput.value = String(next);
          this.updatePartySize(next);
        }
      });
    }

    if (partyInc) {
      partyInc.addEventListener('click', () => {
        const current = Number(partyInput?.value || 1);
        if (current < 50) {
          const next = current + 1;
          if (partyInput) partyInput.value = String(next);
          this.updatePartySize(next);
        }
      });
    }

    // Fetch departures from API
    await this.loadDepartures(pkg.slug);
  }

  /**
   * Load departures for package from backend API
   * @param {string} slug
   */
  static async loadDepartures(slug) {
    const listContainer = document.getElementById('departures-list-container');
    if (!listContainer) return;

    try {
      const items = await api.getPackageDepartures(slug);
      this.departures = Array.isArray(items) ? items : [];
      this.loadingDepartures = false;

      // Auto-select first available departure if present
      if (this.departures.length > 0) {
        const firstAvailable = this.departures.find(
          (d) => d.availabilityStatus === 'AVAILABLE' || d.availabilityStatus === 'FEW_SEATS_LEFT',
        );
        this.selectedDepartureId = firstAvailable
          ? firstAvailable.departureId
          : this.departures[0].departureId;
      }

      this.renderDeparturesList();
      if (this.selectedDepartureId) {
        this.checkPartyAvailability(this.selectedDepartureId, this.partySize);
      }
    } catch (err) {
      this.loadingDepartures = false;
      listContainer.innerHTML = `
        <div class="departures-empty-state error">
          <p>⚠️ Unable to load departure schedules: ${escapeHtml(err.message || 'Please try again')}</p>
          <button type="button" class="btn-secondary btn-sm" id="btn-retry-departures">Retry</button>
        </div>
      `;
      listContainer.querySelector('#btn-retry-departures')?.addEventListener('click', () => {
        this.loadDepartures(slug);
      });
    }
  }

  /**
   * Handle party size change
   * @param {number} newSize
   */
  static updatePartySize(newSize) {
    this.partySize = newSize;
    if (this.selectedDepartureId) {
      this.checkPartyAvailability(this.selectedDepartureId, this.partySize);
    }
  }

  /**
   * Select a departure and inspect live availability for party
   * @param {string} departureId
   */
  static selectDeparture(departureId) {
    const dep = this.departures.find((d) => d.departureId === departureId);
    if (!dep) return;

    // Disabled departures cannot be selected
    if (
      dep.availabilityStatus === 'SOLD_OUT' ||
      dep.availabilityStatus === 'CLOSED' ||
      dep.availabilityStatus === 'CANCELLED'
    ) {
      return;
    }

    this.selectedDepartureId = departureId;
    this.renderDeparturesList();
    this.checkPartyAvailability(departureId, this.partySize);
  }

  /**
   * Check real-time seat availability and party eligibility via backend API
   * @param {string} departureId
   * @param {number} partySize
   */
  static async checkPartyAvailability(departureId, partySize) {
    const alertBox = document.getElementById('party-availability-alert');
    if (!alertBox) return;

    try {
      const live = await api.getDepartureAvailability(departureId, { partySize });

      // Update local departure entry with live data
      const idx = this.departures.findIndex((d) => d.departureId === departureId);
      if (idx !== -1 && live) {
        this.departures[idx] = { ...this.departures[idx], ...live };
        this.renderDeparturesList();
      }

      if (live.isAvailableForParty === false) {
        alertBox.className = 'party-alert-box party-alert-warning';
        alertBox.innerHTML = `
          <span class="alert-icon">⚠️</span>
          <div class="alert-text">
            <strong>Limited Seats Available:</strong> This departure has ${live.availableSeats} seat${live.availableSeats === 1 ? '' : 's'} left, which is less than your party size of ${partySize}. Please reduce your party size or select another departure date.
          </div>
        `;
        alertBox.classList.remove('hidden');
      } else if (live.availabilityStatus === 'FEW_SEATS_LEFT') {
        alertBox.className = 'party-alert-box party-alert-info';
        alertBox.innerHTML = `
          <span class="alert-icon">⚡</span>
          <div class="alert-text">
            <strong>Hurry!</strong> Only ${live.availableSeats} seat${live.availableSeats === 1 ? '' : 's'} remaining for this departure. Guaranteed available for your party of ${partySize}.
          </div>
        `;
        alertBox.classList.remove('hidden');
      } else {
        alertBox.className = 'party-alert-box party-alert-success';
        alertBox.innerHTML = `
          <span class="alert-icon">✓</span>
          <div class="alert-text">
            <strong>Departure Available:</strong> Seats are available for your party of ${partySize} travelers at ${formatPrice(live.effectiveAdultPrice, live.currency)} per adult.
          </div>
        `;
        alertBox.classList.remove('hidden');
      }
    } catch {
      // Non-blocking fallback
      alertBox.classList.add('hidden');
    }
  }

  /**
   * Render the list of departure cards
   */
  static renderDeparturesList() {
    const listContainer = document.getElementById('departures-list-container');
    if (!listContainer) return;

    if (this.departures.length === 0) {
      listContainer.innerHTML = `
        <div class="departures-empty-state">
          <span class="empty-icon">📅</span>
          <p>No upcoming departures are currently scheduled for this package. Contact us for custom departure dates.</p>
        </div>
      `;
      return;
    }

    listContainer.innerHTML = `
      <div class="departures-grid">
        ${this.departures
          .map((dep) => {
            const isSelected = dep.departureId === this.selectedDepartureId;
            const isSelectable =
              dep.availabilityStatus === 'AVAILABLE' || dep.availabilityStatus === 'FEW_SEATS_LEFT';
            const depDate = escapeHtml(dep.departureDate);
            const retDate = escapeHtml(dep.returnDate);
            const price = formatPrice(dep.effectiveAdultPrice, dep.currency);
            const seats = Number(dep.availableSeats ?? 0);

            let statusClass = 'badge-available';
            let statusText = `Available (${seats} seats)`;

            if (dep.availabilityStatus === 'FEW_SEATS_LEFT') {
              statusClass = 'badge-few-seats';
              statusText = `Only ${seats} Left!`;
            } else if (dep.availabilityStatus === 'SOLD_OUT') {
              statusClass = 'badge-sold-out';
              statusText = 'Sold Out';
            } else if (dep.availabilityStatus === 'CLOSED') {
              statusClass = 'badge-closed';
              statusText = 'Closed';
            } else if (dep.availabilityStatus === 'CANCELLED') {
              statusClass = 'badge-cancelled';
              statusText = 'Cancelled';
            }

            return `
              <div
                class="departure-card ${isSelected ? 'selected' : ''} ${!isSelectable ? 'disabled' : ''}"
                data-departure-id="${escapeHtml(dep.departureId)}"
                tabindex="${isSelectable ? '0' : '-1'}"
                role="button"
                aria-pressed="${isSelected}"
                aria-disabled="${!isSelectable}"
              >
                <div class="departure-card-header">
                  <div class="dep-date-range">
                    <span class="dep-calendar-icon" aria-hidden="true">📅</span>
                    <span class="dep-date-text"><strong>${depDate}</strong> &rarr; ${retDate}</span>
                  </div>
                  <span class="badge ${statusClass}">${statusText}</span>
                </div>
                <div class="departure-card-footer">
                  <div class="dep-price-info">
                    <span class="dep-price-label">Price per adult:</span>
                    <span class="dep-price-value">${price}</span>
                  </div>
                  <div class="dep-action">
                    ${
                      isSelected
                        ? '<span class="selected-indicator">✓ Selected</span>'
                        : isSelectable
                          ? '<span class="select-prompt">Select Date &rarr;</span>'
                          : '<span class="unavailable-label">Unavailable</span>'
                    }
                  </div>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
      <div class="departures-booking-footer">
        ${(() => {
          const selectedDep = this.departures.find(
            (d) => d.departureId === this.selectedDepartureId,
          );
          const isSelectable =
            selectedDep &&
            (selectedDep.availabilityStatus === 'AVAILABLE' ||
              selectedDep.availabilityStatus === 'FEW_SEATS_LEFT');

          if (isSelectable) {
            const price = formatPrice(selectedDep.effectiveAdultPrice, selectedDep.currency);
            return `
                <div class="booking-cta-bar">
                  <div class="booking-cta-info">
                    <span class="cta-label">Selected Date: <strong>${escapeHtml(selectedDep.departureDate)}</strong></span>
                    <span class="cta-price">${price} / adult &bull; Party of ${this.partySize}</span>
                  </div>
                  <button type="button" class="btn-primary btn-book-departure" id="btn-book-selected-departure">
                    Book Now &rarr;
                  </button>
                </div>
              `;
          } else {
            return `
                <div class="booking-cta-bar disabled">
                  <p class="phase5-booking-note">
                    Please select an open departure date above to start your reservation.
                  </p>
                </div>
              `;
          }
        })()}
      </div>
    `;

    // Attach listener to Book Departure CTA
    const bookBtn = listContainer.querySelector('#btn-book-selected-departure');
    if (bookBtn) {
      bookBtn.addEventListener('click', () => {
        const selectedDep = this.departures.find((d) => d.departureId === this.selectedDepartureId);
        if (selectedDep) {
          const pkg = this.currentPackage;
          const partySize = this.partySize;
          this.close();
          BookingModal.open({ pkg, departure: selectedDep, initialPartySize: partySize });
        }
      });
    }

    // Attach click and keyboard listeners to selectable departure cards
    listContainer.querySelectorAll('.departure-card:not(.disabled)').forEach((card) => {
      card.addEventListener('click', () => {
        const departureId = card.getAttribute('data-departure-id');
        if (departureId) {
          this.selectDeparture(departureId);
        }
      });

      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const departureId = card.getAttribute('data-departure-id');
          if (departureId) {
            this.selectDeparture(departureId);
          }
        }
      });
    });
  }

  static close() {
    const container = this.getContainer();
    if (!container) return;
    container.classList.add('hidden');
    container.innerHTML = '';
    document.body.style.overflow = '';
    if (this.escListener) {
      window.removeEventListener('keydown', this.escListener);
      this.escListener = null;
    }
  }
}
