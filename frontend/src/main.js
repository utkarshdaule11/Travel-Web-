import { NavbarComponent } from './components/navbar.js';
import { AuthModal } from './components/authModal.js';
import { CatalogueSection } from './components/catalogueSection.js';
import { BookingModal } from './components/bookingModal.js';
import { api } from './api/client.js';

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize UI Components
  AuthModal.init();
  NavbarComponent.init();
  CatalogueSection.init();
  BookingModal.init();

  // Non-blocking background session restoration via HttpOnly cookie
  try {
    await api.restoreSession();
  } catch {
    // Unauthenticated state is normal on initial load / reload
  }

  // Log API Client readiness
  // eslint-disable-next-line no-console
  console.info('🚀 Young Tours & Travels Frontend initialized.');

  // Optional background health check probe
  api
    .checkHealth()
    .then((health) => {
      // eslint-disable-next-line no-console
      console.info('✅ Backend API Health check:', health.status);
    })
    .catch((_err) => {
      // Offline mode or API server not yet started - silent fallback
    });
});
