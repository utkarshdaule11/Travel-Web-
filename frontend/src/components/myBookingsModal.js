import { escapeHtml, formatPrice } from '../utils/formatters.js';
import { api } from '../api/client.js';
import { authStore } from '../state/auth.js';
import { AuthModal } from './authModal.js';
import { BookingDetailModal } from './bookingDetailModal.js';

/**
 * Controller for rendering the Customer "My Bookings" History view.
 */
export class MyBookingsModal {
  static bookings = [];
  static pagination = { page: 1, limit: 10, total: 0, totalPages: 1 };
  static loading = false;

  static getContainer() {
    return document.getElementById('my-bookings-modal');
  }

  /**
   * Open the My Bookings Modal
   * @param {number} page
   */
  static async open(page = 1) {
    const container = this.getContainer();
    if (!container) return;

    if (!authStore.isAuthenticated()) {
      AuthModal.open('login');
      return;
    }

    container.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    this.renderLoading();
    await this.loadBookings(page);
  }

  static renderLoading() {
    const container = this.getContainer();
    if (!container) return;

    container.innerHTML = `
      <div class="modal-card detail-modal-card my-bookings-modal-card" role="document">
        <button type="button" class="modal-close-btn" id="my-bookings-close" aria-label="Close my bookings">&times;</button>
        <div class="booking-modal-header">
          <h2 class="booking-header-title">My Bookings & Reservations</h2>
          <p class="departures-subtitle-text">Track your upcoming trips, reservation holds, and booking history.</p>
        </div>
        <div class="booking-modal-body">
          <div class="departures-loading-spinner">
            <span class="spinner-icon">🔄</span> Loading your bookings...
          </div>
        </div>
      </div>
    `;

    container.querySelector('#my-bookings-close')?.addEventListener('click', () => this.close());
  }

  /**
   * Load customer bookings from API
   * @param {number} page
   */
  static async loadBookings(page = 1) {
    this.loading = true;
    try {
      const response = await api.getMyBookings({ page, limit: 10 });
      this.bookings = Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response)
          ? response
          : [];
      this.pagination = response?.meta || {
        page,
        limit: 10,
        total: this.bookings.length,
        totalPages: Math.max(1, Math.ceil(this.bookings.length / 10)),
      };
      this.loading = false;
      this.renderList();
    } catch (err) {
      this.loading = false;
      this.renderError(err.message || 'Unable to load bookings.');
    }
  }

  /**
   * Render list of bookings
   */
  static renderList() {
    const container = this.getContainer();
    if (!container) return;

    const items = this.bookings;

    container.innerHTML = `
      <div class="modal-card detail-modal-card my-bookings-modal-card" role="document">
        <button type="button" class="modal-close-btn" id="my-bookings-close" aria-label="Close my bookings">&times;</button>
        
        <div class="booking-modal-header">
          <h2 class="booking-header-title">My Bookings & Reservations</h2>
          <p class="departures-subtitle-text">Track your upcoming trips, reservation holds, and booking history.</p>
        </div>

        <div class="booking-modal-body">
          ${
            items.length === 0
              ? `
            <div class="departures-empty-state">
              <span class="empty-icon">🧳</span>
              <h3>No Bookings Yet</h3>
              <p>You have not created any tour reservations yet. Explore our curated packages to start your journey!</p>
              <button type="button" class="btn-primary" id="btn-explore-from-bookings" style="margin-top: 1rem;">Explore Packages</button>
            </div>
          `
              : `
            <div class="my-bookings-list">
              ${items
                .map((b) => {
                  const ref = escapeHtml(b.bookingReference);
                  const pkgTitle = escapeHtml(b.packageSnapshot?.title || 'Tour Package');
                  const depDate = escapeHtml(b.departureSnapshot?.departureDate || 'N/A');
                  const retDate = escapeHtml(b.departureSnapshot?.returnDate || 'N/A');
                  const price = formatPrice(b.totalPrice, b.currency);
                  const status = b.status;

                  let statusBadgeClass = 'badge-warning';
                  if (status === 'CONFIRMED') statusBadgeClass = 'badge-available';
                  else if (status === 'CANCELLED') statusBadgeClass = 'badge-cancelled';
                  else if (status === 'EXPIRED') statusBadgeClass = 'badge-sold-out';

                  return `
                    <div class="my-booking-card" data-ref="${ref}">
                      <div class="my-booking-card-header">
                        <div class="my-booking-title-group">
                          <span class="badge ${statusBadgeClass}">${status}</span>
                          <h4 class="my-booking-package-title">${pkgTitle}</h4>
                        </div>
                        <span class="my-booking-ref">Ref: <strong>${ref}</strong></span>
                      </div>

                      <div class="my-booking-card-body">
                        <div class="my-booking-detail-item">
                          <span class="detail-icon" aria-hidden="true">📅</span>
                          <span><strong>Travel:</strong> ${depDate} &rarr; ${retDate}</span>
                        </div>
                        <div class="my-booking-detail-item">
                          <span class="detail-icon" aria-hidden="true">👥</span>
                          <span><strong>Party:</strong> ${b.partySize} Traveller${b.partySize === 1 ? '' : 's'}</span>
                        </div>
                        <div class="my-booking-detail-item">
                          <span class="detail-icon" aria-hidden="true">💰</span>
                          <span><strong>Total:</strong> ${price}</span>
                        </div>
                      </div>

                      <div class="my-booking-card-footer">
                        <button type="button" class="btn-secondary btn-sm btn-view-booking" data-ref="${ref}">
                          View Details &rarr;
                        </button>
                        ${
                          status === 'CONFIRMED'
                            ? `<button type="button" class="btn-danger btn-sm btn-cancel-booking-row" data-ref="${ref}">Cancel</button>`
                            : ''
                        }
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>

            ${
              this.pagination.totalPages > 1
                ? `
              <div class="pagination-bar" style="margin-top: 1.5rem; justify-content: center;">
                <button
                  type="button"
                  class="btn-secondary btn-sm"
                  id="btn-prev-page"
                  ${this.pagination.page <= 1 ? 'disabled' : ''}
                >&larr; Previous</button>
                <span class="page-info" style="margin: 0 1rem;">Page ${this.pagination.page} of ${this.pagination.totalPages}</span>
                <button
                  type="button"
                  class="btn-secondary btn-sm"
                  id="btn-next-page"
                  ${this.pagination.page >= this.pagination.totalPages ? 'disabled' : ''}
                >Next &rarr;</button>
              </div>
            `
                : ''
            }
          `
          }
        </div>

        <div class="booking-modal-footer">
          <button type="button" class="btn-primary" id="btn-close-my-bookings">Close</button>
        </div>
      </div>
    `;

    // Event listeners
    container.querySelector('#my-bookings-close')?.addEventListener('click', () => this.close());
    container
      .querySelector('#btn-close-my-bookings')
      ?.addEventListener('click', () => this.close());
    container.querySelector('#btn-explore-from-bookings')?.addEventListener('click', () => {
      this.close();
      const pkgSec = document.getElementById('packages');
      pkgSec?.scrollIntoView({ behavior: 'smooth' });
    });

    // View Details buttons
    container.querySelectorAll('.btn-view-booking').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ref = btn.getAttribute('data-ref');
        if (ref) {
          BookingDetailModal.open(ref);
        }
      });
    });

    // Cancel buttons
    container.querySelectorAll('.btn-cancel-booking-row').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ref = btn.getAttribute('data-ref');
        if (ref) {
          const reason = window.prompt('Please provide a cancellation reason:', 'Schedule change');
          if (reason) {
            try {
              btn.disabled = true;
              btn.textContent = 'Cancelling...';
              await api.cancelBooking(ref, reason.trim());
              await this.loadBookings(this.pagination.page);
            } catch (err) {
              btn.disabled = false;
              btn.textContent = 'Cancel';
              alert(`Cancellation failed: ${err.message || 'Error'}`);
            }
          }
        }
      });
    });

    // Pagination
    container.querySelector('#btn-prev-page')?.addEventListener('click', () => {
      if (this.pagination.page > 1) {
        this.loadBookings(this.pagination.page - 1);
      }
    });

    container.querySelector('#btn-next-page')?.addEventListener('click', () => {
      if (this.pagination.page < this.pagination.totalPages) {
        this.loadBookings(this.pagination.page + 1);
      }
    });
  }

  static renderError(message) {
    const container = this.getContainer();
    if (!container) return;

    container.innerHTML = `
      <div class="modal-card detail-modal-card my-bookings-modal-card" role="document">
        <button type="button" class="modal-close-btn" id="my-bookings-close" aria-label="Close my bookings">&times;</button>
        <div class="booking-modal-body">
          <div class="party-alert-box party-alert-warning">
            <span>⚠️ ${escapeHtml(message)}</span>
          </div>
          <div style="text-align: center; margin-top: 1.5rem;">
            <button type="button" class="btn-secondary" id="btn-retry-my-bookings">Retry</button>
            <button type="button" class="btn-primary" id="btn-close-error">Close</button>
          </div>
        </div>
      </div>
    `;

    container.querySelector('#my-bookings-close')?.addEventListener('click', () => this.close());
    container.querySelector('#btn-close-error')?.addEventListener('click', () => this.close());
    container.querySelector('#btn-retry-my-bookings')?.addEventListener('click', () => {
      this.loadBookings(1);
    });
  }

  static close() {
    const container = this.getContainer();
    if (container) {
      container.classList.add('hidden');
      container.innerHTML = '';
      document.body.style.overflow = '';
    }
  }
}
