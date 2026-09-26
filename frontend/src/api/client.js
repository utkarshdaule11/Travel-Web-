import { config } from '../config.js';
import { authStore } from '../state/auth.js';

/**
 * Standard API Client with in-memory Bearer token injection,
 * automatic 401 refresh rotation retry, and session restoration.
 */
export class ApiClient {
  constructor(baseUrl = config.apiBaseUrl, store = authStore) {
    this.baseUrl = baseUrl;
    this.store = store;
    this.refreshPromise = null;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    };

    // Attach in-memory access token if available and not skipped
    const token = this.store.getAccessToken();
    if (token && !options.skipAuth && !headers['Authorization'] && !headers['authorization']) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const fetchOptions = {
      ...options,
      headers,
      credentials: options.credentials || 'include',
    };

    try {
      const response = await fetch(url, fetchOptions);

      // Handle 401 Unauthorized with single token refresh retry
      if (
        response.status === 401 &&
        options.retry !== false &&
        !endpoint.includes('/auth/refresh') &&
        !endpoint.includes('/auth/login') &&
        !endpoint.includes('/auth/register')
      ) {
        try {
          await this.refreshSession();
          // Retry the original request exactly once with rotated token
          return await this.request(endpoint, {
            ...options,
            retry: false,
          });
        } catch (refreshErr) {
          this.store.clearSession();
          throw refreshErr;
        }
      }

      let json;
      try {
        json = await response.json();
      } catch {
        json = null;
      }

      if (!response.ok || !json?.success) {
        const errorMsg =
          json?.error?.message || `HTTP Error ${response.status}: ${response.statusText}`;
        const error = new Error(errorMsg);
        error.status = response.status;
        error.code = json?.error?.code;
        error.details = json?.error?.details || [];
        throw error;
      }

      if (options.includeMeta) {
        return { data: json.data, meta: json.meta };
      }

      return json.data;
    } catch (err) {
      if (!options.silent) {
        // eslint-disable-next-line no-console
        console.error(`[API Client Error] ${options.method || 'GET'} ${url}:`, err);
      }
      throw err;
    }
  }

  async get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  async post(endpoint, body, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  // --- Programmatic Authentication API ---

  async register(data) {
    const response = await this.post('/auth/register', data, {
      skipAuth: true,
      retry: false,
    });
    this.store.setSession(response.user, response.accessToken);
    return response;
  }

  async login(credentials) {
    const response = await this.post('/auth/login', credentials, {
      skipAuth: true,
      retry: false,
    });
    this.store.setSession(response.user, response.accessToken);
    return response;
  }

  async refreshSession() {
    // Shared promise concurrency guard prevents duplicate refresh storms
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const response = await this.post('/auth/refresh', undefined, {
          skipAuth: true,
          retry: false,
          silent: true,
        });
        this.store.setSession(response.user, response.accessToken);
        return response;
      } catch (err) {
        this.store.clearSession();
        throw err;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  async restoreSession() {
    this.store.setRestoring();
    try {
      const response = await this.refreshSession();
      return response;
    } catch {
      this.store.clearSession();
      return null;
    }
  }

  async logout() {
    try {
      await this.post('/auth/logout', undefined, {
        skipAuth: true,
        retry: false,
        silent: true,
      });
    } finally {
      this.store.clearSession();
    }
  }

  async getCurrentUser() {
    const response = await this.get('/auth/me');
    return response.user;
  }

  async checkHealth() {
    return this.get('/health', { skipAuth: true });
  }

  // --- Public Catalogue & Search APIs ---

  async getDestinations(params = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.isFeatured !== undefined) query.set('isFeatured', String(params.isFeatured));
    const qs = query.toString();
    return this.get(`/destinations${qs ? `?${qs}` : ''}`, { skipAuth: true });
  }

  async getDestinationBySlug(slug) {
    if (!slug) throw new Error('Destination slug is required');
    return this.get(`/destinations/${encodeURIComponent(slug)}`, { skipAuth: true });
  }

  async getThemes() {
    return this.get('/themes', { skipAuth: true });
  }

  async getPackages(params = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.destinationSlug) query.set('destinationSlug', String(params.destinationSlug));
    if (params.themeSlug) query.set('themeSlug', String(params.themeSlug));
    if (params.isFeatured !== undefined) query.set('isFeatured', String(params.isFeatured));
    const qs = query.toString();
    return this.get(`/packages${qs ? `?${qs}` : ''}`, { skipAuth: true });
  }

  async getPackageBySlug(slug) {
    if (!slug) throw new Error('Package slug is required');
    return this.get(`/packages/${encodeURIComponent(slug)}`, { skipAuth: true });
  }

  // --- Phase 4 Search, Departure & Availability APIs ---

  async searchPackages(params = {}, options = {}) {
    const query = new URLSearchParams();
    if (params.q) query.set('q', String(params.q).trim());
    if (params.destinationSlug) query.set('destinationSlug', String(params.destinationSlug).trim());
    if (params.themeSlug) query.set('themeSlug', String(params.themeSlug).trim());
    if (
      params.minDuration !== undefined &&
      params.minDuration !== null &&
      params.minDuration !== ''
    ) {
      query.set('minDuration', String(params.minDuration));
    }
    if (
      params.maxDuration !== undefined &&
      params.maxDuration !== null &&
      params.maxDuration !== ''
    ) {
      query.set('maxDuration', String(params.maxDuration));
    }
    if (params.maxPrice !== undefined && params.maxPrice !== null && params.maxPrice !== '') {
      query.set('maxPrice', String(params.maxPrice));
    }
    if (params.minPrice !== undefined && params.minPrice !== null && params.minPrice !== '') {
      query.set('minPrice', String(params.minPrice));
    }
    if (params.currency) query.set('currency', String(params.currency));
    if (params.departureDateFrom) query.set('departureDateFrom', String(params.departureDateFrom));
    if (params.departureDateTo) query.set('departureDateTo', String(params.departureDateTo));
    if (params.isFeatured !== undefined && params.isFeatured !== null && params.isFeatured !== '') {
      query.set('isFeatured', String(params.isFeatured));
    }
    if (params.sortBy) query.set('sortBy', String(params.sortBy));
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));

    const qs = query.toString();
    const endpoint = `/packages/search${qs ? `?${qs}` : ''}`;
    const result = await this.get(endpoint, {
      skipAuth: true,
      includeMeta: true,
      ...options,
    });
    return {
      items: Array.isArray(result?.data) ? result.data : [],
      pagination: result?.meta || {
        page: Number(params.page) || 1,
        limit: Number(params.limit) || 12,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPrevPage: false,
      },
    };
  }

  async getPackageDepartures(slug, options = {}) {
    if (!slug) throw new Error('Package slug is required');
    return this.get(`/packages/${encodeURIComponent(slug)}/departures`, {
      skipAuth: true,
      ...options,
    });
  }

  async getDepartureAvailability(departureId, params = {}, options = {}) {
    if (!departureId) throw new Error('Departure ID is required');
    const query = new URLSearchParams();
    if (params.partySize) query.set('partySize', String(params.partySize));
    const qs = query.toString();
    return this.get(
      `/departures/${encodeURIComponent(departureId)}/availability${qs ? `?${qs}` : ''}`,
      {
        skipAuth: true,
        ...options,
      },
    );
  }

  // --- Phase 5 Customer Booking APIs ---

  async createBooking(data, idempotencyKey = null, options = {}) {
    const key =
      idempotencyKey ||
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          }));

    const headers = {
      'idempotency-key': key,
      ...(options.headers || {}),
    };

    return this.post('/bookings', data, {
      ...options,
      headers,
      includeMeta: true,
    });
  }

  async getMyBookings(params = {}, options = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.status) query.set('status', String(params.status));
    const qs = query.toString();
    return this.get(`/bookings${qs ? `?${qs}` : ''}`, {
      includeMeta: true,
      ...options,
    });
  }

  async getBookingByReference(reference, options = {}) {
    if (!reference) throw new Error('Booking reference is required');
    return this.get(`/bookings/${encodeURIComponent(reference)}`, options);
  }

  async cancelBooking(reference, reason = 'Customer requested cancellation', options = {}) {
    if (!reference) throw new Error('Booking reference is required');
    return this.post(`/bookings/${encodeURIComponent(reference)}/cancel`, { reason }, options);
  }
}

export const api = new ApiClient();
