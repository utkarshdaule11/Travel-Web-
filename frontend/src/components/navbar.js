import { authStore, AuthStatus } from '../state/auth.js';
import { AuthModal } from './authModal.js';
import { MyBookingsModal } from './myBookingsModal.js';
import { api } from '../api/client.js';

/**
 * Navbar component controller for scroll animations and reactive authentication state.
 */
export class NavbarComponent {
  static init() {
    const navbar = document.querySelector('.navbar');
    if (!navbar) return;

    // Scroll styling transition
    window.addEventListener('scroll', () => {
      if (window.scrollY > 50) {
        navbar.classList.add('scrolled');
      } else {
        navbar.classList.remove('scrolled');
      }
    });

    // Ensure nav-auth container exists
    let authContainer = document.getElementById('nav-auth-container');
    if (!authContainer) {
      const navLinks = navbar.querySelector('.nav-links');
      if (navLinks) {
        authContainer = document.createElement('li');
        authContainer.id = 'nav-auth-container';
        authContainer.className = 'nav-auth-item';
        navLinks.appendChild(authContainer);
      }
    }

    // Initial render and subscription to auth store
    this.renderAuthState({
      status: authStore.getStatus(),
      user: authStore.getUser(),
      isAuthenticated: authStore.isAuthenticated(),
    });

    authStore.subscribe((state) => {
      this.renderAuthState(state);
    });
  }

  /**
   * Render authenticated or unauthenticated UI controls in navbar.
   * @param {{ status: string, user: object|null, isAuthenticated: boolean }} state
   */
  static renderAuthState(state) {
    const container = document.getElementById('nav-auth-container');
    if (!container) return;

    if (state.isAuthenticated && state.user) {
      const firstName = (state.user.fullName || 'Traveller').split(' ')[0];
      // Escape HTML entities for safe greeting rendering
      const safeName = firstName.replace(/</g, '&lt;').replace(/>/g, '&gt;');

      container.innerHTML = `
        <div class="nav-user-greeting">
          <span class="user-greeting-text" id="user-greeting-text">Hi, ${safeName}</span>
          <button type="button" class="btn-secondary btn-sm btn-nav-bookings" id="nav-my-bookings-btn" aria-label="View your bookings">My Bookings</button>
          <button type="button" class="btn-logout" id="nav-logout-btn" aria-label="Sign out of your account">Logout</button>
        </div>
      `;

      const bookingsBtn = container.querySelector('#nav-my-bookings-btn');
      if (bookingsBtn) {
        bookingsBtn.addEventListener('click', () => MyBookingsModal.open());
      }

      const logoutBtn = container.querySelector('#nav-logout-btn');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
          try {
            logoutBtn.disabled = true;
            logoutBtn.textContent = 'Logging out...';
            await api.logout();
          } catch {
            // Local state is cleared in finally inside client.logout()
          }
        });
      }
    } else {
      container.innerHTML = `
        <div class="nav-auth-buttons">
          <button type="button" class="btn-secondary btn-nav-auth" id="nav-login-btn">Login</button>
          <button type="button" class="btn-primary btn-nav-auth" id="nav-register-btn">Register</button>
        </div>
      `;

      const loginBtn = container.querySelector('#nav-login-btn');
      const registerBtn = container.querySelector('#nav-register-btn');

      if (loginBtn) {
        loginBtn.addEventListener('click', () => AuthModal.open('login'));
      }
      if (registerBtn) {
        registerBtn.addEventListener('click', () => AuthModal.open('register'));
      }
    }
  }
}
