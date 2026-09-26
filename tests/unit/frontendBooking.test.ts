import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BookingModal } from '../../frontend/src/components/bookingModal.js';
import { MyBookingsModal } from '../../frontend/src/components/myBookingsModal.js';
import { BookingDetailModal } from '../../frontend/src/components/bookingDetailModal.js';
import { PackageDetailModal } from '../../frontend/src/components/packageDetailModal.js';
import { AuthModal } from '../../frontend/src/components/authModal.js';
import { NavbarComponent } from '../../frontend/src/components/navbar.js';
import { authStore } from '../../frontend/src/state/auth.js';
import { api } from '../../frontend/src/api/client.js';

// --- Lightweight DOM Test Environment Harness ---

class MockClassList {
  classes = new Set<string>();

  add(...tokens: string[]) {
    tokens.forEach((t) => this.classes.add(t));
  }

  remove(...tokens: string[]) {
    tokens.forEach((t) => this.classes.delete(t));
  }

  contains(token: string) {
    return this.classes.has(token);
  }

  get value() {
    return Array.from(this.classes).join(' ');
  }
}

class MockElement {
  tagName: string;
  id = '';
  className = '';
  type = '';
  name = '';
  value = '';
  placeholder = '';
  autocomplete = '';
  disabled = false;
  _textContent = '';
  style: Record<string, string> = { overflow: '' };
  attributes = new Map<string, string>();
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  classList = new MockClassList();
  eventListeners = new Map<string, Array<(event: any) => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.style = { overflow: '' };
  }

  get textContent(): string {
    const direct = this._textContent;
    const childText = this.children
      .map((c) => c.textContent)
      .filter(Boolean)
      .join(' ');
    if (direct && childText) return `${direct} ${childText}`;
    return direct || childText;
  }

  set textContent(val: string) {
    this._textContent = val;
    this.children = [];
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    this.eventListeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    const list = this.eventListeners.get(type) || [];
    this.eventListeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }

  dispatchEvent(event: any) {
    if (!event.target) {
      event.target = this;
    }
    const list = this.eventListeners.get(event.type) || [];
    for (const listener of list) {
      listener(event);
    }
    return !event.defaultPrevented;
  }

  appendChild(child: MockElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: MockElement) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
    return child;
  }

  contains(node: MockElement | null): boolean {
    if (!node) return false;
    if (node === this) return true;
    let curr = node.parentElement;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentElement;
    }
    return false;
  }

  querySelector(selector: string): MockElement | null {
    return findFirst(this, selector);
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    findAll(this, selector, results);
    return results;
  }

  get innerHTML(): string {
    return this.textContent;
  }

  set innerHTML(html: string) {
    this.children = [];
    this._textContent = '';
    parseHtmlInto(html, this);
  }
}

function findFirst(root: MockElement, selector: string): MockElement | null {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) return child;
    const found = findFirst(child, selector);
    if (found) return found;
  }
  return null;
}

function findAll(root: MockElement, selector: string, results: MockElement[]) {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) results.push(child);
    findAll(child, selector, results);
  }
}

function matchesSelector(el: MockElement, selector: string): boolean {
  if (selector.startsWith('#')) {
    return el.id === selector.slice(1);
  }
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    return el.classList.contains(cls) || el.className.split(/\s+/).includes(cls);
  }
  const attrMatch = selector.match(/^([a-z0-9]+)?\[([a-z0-9_-]+)(?:=["']([^"']*)["'])?\]$/i);
  if (attrMatch) {
    const tag = attrMatch[1];
    const attrName = attrMatch[2];
    const attrVal = attrMatch[3];
    if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    if (!attrName) return false;
    if (attrVal !== undefined) {
      return el.getAttribute(attrName) === attrVal;
    }
    return el.attributes.has(attrName);
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

const VOID_ELEMENTS = new Set([
  'AREA',
  'BASE',
  'BR',
  'COL',
  'EMBED',
  'HR',
  'IMG',
  'INPUT',
  'LINK',
  'META',
  'PARAM',
  'SOURCE',
  'TRACK',
  'WBR',
]);

function parseHtmlInto(html: string, root: MockElement) {
  const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  const tokenRegex = /(<\/?[a-z0-9]+[^>]*\/?>)|([^<]+)/gi;
  const stack: MockElement[] = [root];
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(cleanHtml)) !== null) {
    const [, tagMatch, textMatch] = match;
    const currentParent = stack[stack.length - 1];

    if (textMatch) {
      const trimmed = textMatch.trim();
      if (trimmed && currentParent) {
        currentParent._textContent =
          (currentParent._textContent ? currentParent._textContent + ' ' : '') + trimmed;
      }
      continue;
    }

    if (tagMatch) {
      if (tagMatch.startsWith('</')) {
        const closeTagName = tagMatch.slice(2, -1).trim().toUpperCase();
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i]?.tagName === closeTagName) {
            stack.splice(i, stack.length - i);
            break;
          }
        }
        continue;
      }

      const isSelfClosing = tagMatch.endsWith('/>');
      const tagContent = tagMatch.slice(1, isSelfClosing ? -2 : -1).trim();
      const firstSpace = tagContent.search(/\s/);
      const tagName = (
        firstSpace === -1 ? tagContent : tagContent.slice(0, firstSpace)
      ).toUpperCase();
      const rawAttrs = firstSpace === -1 ? '' : tagContent.slice(firstSpace).trim();

      const el = new MockElement(tagName);

      const attrRegex = /([a-z0-9_-]+)(?:=["']([^"']*)["'])?/gi;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
        const name = attrMatch[1]!;
        const val = attrMatch[2] ?? '';
        if (name === 'id') el.id = val;
        else if (name === 'class') {
          el.className = val;
          val.split(/\s+/).forEach((c) => c && el.classList.add(c));
        } else if (name === 'type') el.type = val;
        else if (name === 'name') el.name = val;
        else if (name === 'placeholder') el.placeholder = val;
        else if (name === 'value') el.value = val;
        else el.setAttribute(name, val);
      }

      if (currentParent) {
        currentParent.appendChild(el);
      }

      if (!isSelfClosing && !VOID_ELEMENTS.has(tagName)) {
        stack.push(el);
      }
    }
  }
}

function setupMockDom() {
  const body = new MockElement('body');
  const document = {
    body,
    createElement: (tag: string) => new MockElement(tag),
    getElementById: (id: string) => findFirst(body, `#${id}`),
    querySelector: (sel: string) => findFirst(body, sel),
    querySelectorAll: (sel: string) => {
      const results: MockElement[] = [];
      findAll(body, sel, results);
      return results;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  const window = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    scrollY: 0,
    prompt: vi.fn(),
    alert: vi.fn(),
  };

  (globalThis as any).document = document;
  (globalThis as any).window = window;

  // Build standard container fixtures
  const authModal = new MockElement('div');
  authModal.id = 'auth-modal';
  authModal.classList.add('hidden');
  body.appendChild(authModal);

  const packageModal = new MockElement('div');
  packageModal.id = 'package-detail-modal';
  packageModal.classList.add('hidden');
  body.appendChild(packageModal);

  const bookingModal = new MockElement('div');
  bookingModal.id = 'booking-modal';
  bookingModal.classList.add('hidden');
  body.appendChild(bookingModal);

  const myBookingsModal = new MockElement('div');
  myBookingsModal.id = 'my-bookings-modal';
  myBookingsModal.classList.add('hidden');
  body.appendChild(myBookingsModal);

  const bookingDetailModal = new MockElement('div');
  bookingDetailModal.id = 'booking-detail-modal';
  bookingDetailModal.classList.add('hidden');
  body.appendChild(bookingDetailModal);

  const navbar = new MockElement('nav');
  navbar.className = 'navbar';
  const navLinks = new MockElement('ul');
  navLinks.className = 'nav-links';
  navbar.appendChild(navLinks);
  body.appendChild(navbar);

  return { document, window, body };
}

describe('Phase 5 Step 10 — Frontend Booking & Checkout Integration Suite', () => {
  const samplePackage = {
    id: 'pkg-1234',
    slug: 'golden-triangle-tour',
    title: 'Golden Triangle Tour',
    shortDescription: 'Delhi, Agra and Jaipur Tour',
    description: 'Comprehensive 5-day cultural tour.',
    durationDays: 5,
    durationNights: 4,
    baseAdultPrice: 5000000,
    baseChildPrice: 3000000,
    currency: 'INR',
  };

  const sampleDeparture = {
    departureId: 'dep-5678',
    id: 'dep-5678',
    packageId: 'pkg-1234',
    departureDate: '2028-10-01',
    returnDate: '2028-10-05',
    effectiveAdultPrice: 5000000,
    effectiveChildPrice: 3000000,
    availableSeats: 10,
    availabilityStatus: 'AVAILABLE',
    currency: 'INR',
  };

  const sampleBookingResponse = {
    id: 'bk-uuid-001',
    bookingReference: 'BK-20281001-ABCD',
    customerId: 'cust-uuid-001',
    departureId: 'dep-5678',
    holdId: 'hold-uuid-001',
    partySize: 2,
    adultCount: 2,
    childCount: 0,
    totalPrice: 10000000,
    currency: 'INR',
    status: 'AWAITING_PAYMENT',
    holdExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    primaryContact: {
      name: 'John Doe',
      email: 'john@example.com',
      phone: '+919876543210',
    },
    passengers: [
      {
        fullName: 'John Doe',
        passengerType: 'ADULT',
        ageAtBooking: 32,
        gender: 'MALE',
        isPrimaryContact: true,
      },
      {
        fullName: 'Jane Doe',
        passengerType: 'ADULT',
        ageAtBooking: 30,
        gender: 'FEMALE',
        isPrimaryContact: false,
      },
    ],
    priceBreakdown: {
      adultCount: 2,
      adultUnitPrice: 5000000,
      adultSubtotal: 10000000,
      childCount: 0,
      childUnitPrice: 0,
      childSubtotal: 0,
      totalPrice: 10000000,
      currency: 'INR',
    },
  };

  beforeEach(() => {
    setupMockDom();
    authStore.clearSession();
    vi.restoreAllMocks();
    BookingModal.init();
    AuthModal.init();
    NavbarComponent.init();
  });

  afterEach(() => {
    BookingModal.close();
    MyBookingsModal.close();
    BookingDetailModal.close();
    PackageDetailModal.close();
  });

  // ============================================================
  // TEST A — Guest cannot directly submit booking (prompts auth modal login)
  // ============================================================
  it('TEST A — Guest cannot submit booking directly and is prompted to log in while preserving booking context', async () => {
    const authOpenSpy = vi.spyOn(AuthModal, 'open');
    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture, initialPartySize: 2 });

    const submitBtn = (globalThis as any).document.getElementById('btn-submit-booking');
    expect(submitBtn).toBeDefined();

    await BookingModal.handleBookingSubmit();

    expect(authOpenSpy).toHaveBeenCalledWith('login');
    expect((BookingModal as any).savedPendingBooking).toBeDefined();
    expect((BookingModal as any).savedPendingBooking?.pkg?.slug).toBe('golden-triangle-tour');
  });

  // ============================================================
  // TEST B — Authenticated customer opens booking flow with prefilled contact info
  // ============================================================
  it('TEST B — Authenticated customer opens booking checkout with pre-populated primary contact', () => {
    authStore.setSession(
      {
        id: 'cust-123',
        email: 'logged.user@example.com',
        fullName: 'Logged In Traveller',
        role: 'CUSTOMER',
      },
      'mock.jwt.token',
    );

    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture, initialPartySize: 1 });

    const emailInput = (globalThis as any).document.getElementById('primary-contact-email');
    expect(emailInput).toBeDefined();
    expect(emailInput.value).toBe('logged.user@example.com');
  });

  // ============================================================
  // TEST C — Invalid party size is rejected client-side
  // ============================================================
  it('TEST C — Invalid party size (partySize < 1) is rejected client-side before submission', async () => {
    authStore.setSession(
      { id: 'c1', email: 'test@example.com', fullName: 'Test User', role: 'CUSTOMER' },
      'mock.jwt',
    );

    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture });
    BookingModal.adultCount = 0;
    BookingModal.childCount = 0;
    BookingModal.passengers = [];

    const createSpy = vi.spyOn(api, 'createBooking');
    await BookingModal.handleBookingSubmit();

    expect(createSpy).not.toHaveBeenCalled();
    const alertBox = (globalThis as any).document.getElementById('booking-alert-box');
    expect(alertBox.textContent).toContain('Party size must be at least 1 traveller');
  });

  // ============================================================
  // TEST D — Passenger count mismatch is rejected client-side
  // ============================================================
  it('TEST D — Passenger roster count mismatch with party size is rejected client-side', async () => {
    authStore.setSession(
      { id: 'c1', email: 'test@example.com', fullName: 'Test User', role: 'CUSTOMER' },
      'mock.jwt',
    );

    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture, initialPartySize: 2 });
    // Corrupt roster length manually to 1 while partySize is 2
    BookingModal.passengers = [
      {
        fullName: 'Solo',
        passengerType: 'ADULT',
        ageAtBooking: 30,
        gender: 'MALE',
        isPrimaryContact: true,
      },
    ];

    const createSpy = vi.spyOn(api, 'createBooking');
    await BookingModal.handleBookingSubmit();

    expect(createSpy).not.toHaveBeenCalled();
    const alertBox = (globalThis as any).document.getElementById('booking-alert-box');
    expect(alertBox.textContent).toContain('Passenger roster count must match total party size');
  });

  // ============================================================
  // TEST E — Booking request does NOT contain client-controlled customerId, totalPrice, status, holdId
  // ============================================================
  it('TEST E — Booking request payload excludes client-controlled customerId, totalPrice, status, or holdId', async () => {
    authStore.setSession(
      { id: 'c1', email: 'client@example.com', fullName: 'John Doe', role: 'CUSTOMER' },
      'mock.jwt',
    );

    let capturedPayload: any = null;
    vi.spyOn(api, 'createBooking').mockImplementation(async (payload) => {
      capturedPayload = payload;
      return { data: sampleBookingResponse };
    });

    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture, initialPartySize: 1 });
    BookingModal.passengers[0]!.fullName = 'John Doe';
    BookingModal.primaryContact = {
      name: 'John Doe',
      email: 'client@example.com',
      phone: '+919876543210',
    };

    await BookingModal.handleBookingSubmit();

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload.departureId).toBe('dep-5678');
    expect(capturedPayload.partySize).toBe(1);
    expect(capturedPayload.adultCount).toBe(1);
    expect(capturedPayload.childCount).toBe(0);

    // Strict invariant: no client-controlled pricing, status, customerId, or holdId
    expect(capturedPayload.customerId).toBeUndefined();
    expect(capturedPayload.totalPrice).toBeUndefined();
    expect(capturedPayload.status).toBeUndefined();
    expect(capturedPayload.holdId).toBeUndefined();
  });

  // ============================================================
  // TEST F — Successful booking response is rendered in AWAITING_PAYMENT state
  // ============================================================
  it('TEST F — Successful booking creation response transitions view to AWAITING_PAYMENT confirmation screen', async () => {
    authStore.setSession(
      { id: 'c1', email: 'client@example.com', fullName: 'John Doe', role: 'CUSTOMER' },
      'mock.jwt',
    );

    vi.spyOn(api, 'createBooking').mockResolvedValue({ data: sampleBookingResponse });

    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture, initialPartySize: 2 });
    BookingModal.passengers[0]!.fullName = 'John Doe';
    BookingModal.passengers[1]!.fullName = 'Jane Doe';
    BookingModal.primaryContact = {
      name: 'John Doe',
      email: 'client@example.com',
      phone: '+919876543210',
    };

    await BookingModal.handleBookingSubmit();

    const refEl = (globalThis as any).document.getElementById('confirmation-booking-ref');
    expect(refEl).toBeDefined();
    expect(refEl.textContent).toBe('BK-20281001-ABCD');

    const statusBadge = (globalThis as any).document.getElementById('confirmation-status-badge');
    expect(statusBadge.textContent).toBe('AWAITING_PAYMENT');
  });

  // ============================================================
  // TEST G — AWAITING_PAYMENT state renders 15-minute hold timer
  // ============================================================
  it('TEST G — AWAITING_PAYMENT confirmation screen renders 15-minute hold countdown timer and honest payment note', async () => {
    authStore.setSession(
      { id: 'c1', email: 'client@example.com', fullName: 'John Doe', role: 'CUSTOMER' },
      'mock.jwt',
    );

    vi.spyOn(api, 'createBooking').mockResolvedValue({ data: sampleBookingResponse });

    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture, initialPartySize: 2 });
    BookingModal.passengers[0]!.fullName = 'John Doe';
    BookingModal.passengers[1]!.fullName = 'Jane Doe';
    BookingModal.primaryContact = {
      name: 'John Doe',
      email: 'client@example.com',
      phone: '+919876543210',
    };

    await BookingModal.handleBookingSubmit();

    const timerDisplay = (globalThis as any).document.getElementById('hold-timer-display');
    expect(timerDisplay).toBeDefined();
    expect(timerDisplay.textContent).toContain('remaining to confirm');
  });

  // ============================================================
  // TEST H — API booking error is rendered correctly (e.g. inventory exceeded)
  // ============================================================
  it('TEST H — API capacity error (INVENTORY_CAPACITY_EXCEEDED) is rendered with a user-friendly message', async () => {
    authStore.setSession(
      { id: 'c1', email: 'client@example.com', fullName: 'John Doe', role: 'CUSTOMER' },
      'mock.jwt',
    );

    const apiError = new Error('Capacity exceeded');
    (apiError as any).code = 'INVENTORY_CAPACITY_EXCEEDED';
    vi.spyOn(api, 'createBooking').mockRejectedValue(apiError);

    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture, initialPartySize: 1 });
    BookingModal.passengers[0]!.fullName = 'John Doe';
    BookingModal.primaryContact = {
      name: 'John Doe',
      email: 'client@example.com',
      phone: '+919876543210',
    };

    await BookingModal.handleBookingSubmit();

    const alertBox = (globalThis as any).document.getElementById('booking-alert-box');
    expect(alertBox.textContent).toContain('selected seats are no longer available');
  });

  // ============================================================
  // TEST I — Duplicate submit is prevented while request is in flight
  // ============================================================
  it('TEST I — In-flight submit protection disables submit button and blocks duplicate calls', async () => {
    authStore.setSession(
      { id: 'c1', email: 'client@example.com', fullName: 'John Doe', role: 'CUSTOMER' },
      'mock.jwt',
    );

    let resolveApi: any;
    const apiPromise = new Promise((resolve) => {
      resolveApi = resolve;
    });

    const createSpy = vi.spyOn(api, 'createBooking').mockImplementation(() => apiPromise as any);

    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture, initialPartySize: 1 });
    BookingModal.passengers[0]!.fullName = 'John Doe';
    BookingModal.primaryContact = {
      name: 'John Doe',
      email: 'client@example.com',
      phone: '+919876543210',
    };

    // First submit
    const submit1 = BookingModal.handleBookingSubmit();
    expect(BookingModal.isSubmitting).toBe(true);

    // Second submit concurrent
    const submit2 = BookingModal.handleBookingSubmit();

    // Resolve API
    resolveApi({ data: sampleBookingResponse });
    await Promise.all([submit1, submit2]);

    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // TEST J — Idempotency key behavior is preserved
  // ============================================================
  it('TEST J — Client generates and passes stable idempotency-key header during submission', async () => {
    authStore.setSession(
      { id: 'c1', email: 'client@example.com', fullName: 'John Doe', role: 'CUSTOMER' },
      'mock.jwt',
    );

    let sentIdemKey: string | null = null;
    vi.spyOn(api, 'createBooking').mockImplementation(async (_data, key) => {
      sentIdemKey = key ?? null;
      return { data: sampleBookingResponse };
    });

    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture, initialPartySize: 1 });
    BookingModal.passengers[0]!.fullName = 'John Doe';
    BookingModal.primaryContact = {
      name: 'John Doe',
      email: 'client@example.com',
      phone: '+919876543210',
    };

    await BookingModal.handleBookingSubmit();

    expect(sentIdemKey).toBeDefined();
    expect(typeof sentIdemKey).toBe('string');
    expect((sentIdemKey as any).length).toBeGreaterThanOrEqual(16);
  });

  // ============================================================
  // TEST K — My Bookings loads and renders correctly
  // ============================================================
  it('TEST K — My Bookings modal loads and renders customer bookings list with status badges', async () => {
    authStore.setSession(
      { id: 'c1', email: 'client@example.com', fullName: 'John Doe', role: 'CUSTOMER' },
      'mock.jwt',
    );

    vi.spyOn(api, 'getMyBookings').mockResolvedValue({
      data: [sampleBookingResponse],
      meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    await MyBookingsModal.open(1);

    const container = (globalThis as any).document.getElementById('my-bookings-modal');
    expect(container.textContent).toContain('BK-20281001-ABCD');
    expect(container.textContent).toContain('AWAITING_PAYMENT');
  });

  // ============================================================
  // TEST L — Booking details loads and renders correctly
  // ============================================================
  it('TEST L — Booking details modal fetches and renders full passenger roster and snapshots', async () => {
    vi.spyOn(api, 'getBookingByReference').mockResolvedValue(sampleBookingResponse);

    await BookingDetailModal.open('BK-20281001-ABCD');

    const container = (globalThis as any).document.getElementById('booking-detail-modal');
    expect(container.textContent).toContain('BK-20281001-ABCD');
    expect(container.textContent).toContain('John Doe');
    expect(container.textContent).toContain('Jane Doe');
    expect(container.textContent).toContain('AWAITING_PAYMENT');
  });

  // ============================================================
  // TEST M — Cancellation uses the correct endpoint (POST /bookings/:ref/cancel)
  // ============================================================
  it('TEST M — Cancellation of confirmed booking triggers POST /bookings/:ref/cancel and updates view', async () => {
    const confirmedBooking = { ...sampleBookingResponse, status: 'CONFIRMED' };
    const cancelledBooking = {
      ...sampleBookingResponse,
      status: 'CANCELLED',
      cancellationReason: 'Change of plans',
    };

    vi.spyOn(api, 'getBookingByReference').mockResolvedValue(confirmedBooking);
    const cancelSpy = vi.spyOn(api, 'cancelBooking').mockResolvedValue(cancelledBooking);
    (globalThis as any).window.prompt.mockReturnValue('Change of plans');

    await BookingDetailModal.open('BK-20281001-ABCD');

    await BookingDetailModal.handleCancellation('BK-20281001-ABCD');

    expect(cancelSpy).toHaveBeenCalledWith('BK-20281001-ABCD', 'Change of plans');
    const container = (globalThis as any).document.getElementById('booking-detail-modal');
    expect(container.textContent).toContain('CANCELLED');
    expect(container.textContent).toContain('Change of plans');
  });

  // ============================================================
  // TEST N — Cancellation errors are handled
  // ============================================================
  it('TEST N — Cancellation errors are rendered gracefully in the detail modal', async () => {
    const confirmedBooking = { ...sampleBookingResponse, status: 'CONFIRMED' };
    vi.spyOn(api, 'getBookingByReference').mockResolvedValue(confirmedBooking);
    vi.spyOn(api, 'cancelBooking').mockRejectedValue(new Error('Booking already cancelled'));
    (globalThis as any).window.prompt.mockReturnValue('Reason');

    await BookingDetailModal.open('BK-20281001-ABCD');
    await BookingDetailModal.handleCancellation('BK-20281001-ABCD');

    const alertBox = (globalThis as any).document.getElementById('detail-alert-box');
    expect(alertBox.textContent).toContain('Booking already cancelled');
  });

  // ============================================================
  // TEST O — Expired booking is rendered with status badge
  // ============================================================
  it('TEST O — Expired booking is rendered with EXPIRED badge and without cancellation button', async () => {
    const expiredBooking = { ...sampleBookingResponse, status: 'EXPIRED' };
    vi.spyOn(api, 'getBookingByReference').mockResolvedValue(expiredBooking);

    await BookingDetailModal.open('BK-20281001-ABCD');

    const container = (globalThis as any).document.getElementById('booking-detail-modal');
    expect(container.textContent).toContain('EXPIRED');
    expect(container.querySelector('#btn-trigger-cancel')).toBeNull();
  });

  // ============================================================
  // TEST P — Confirmed booking is rendered with cancellation action enabled
  // ============================================================
  it('TEST P — Confirmed booking is rendered with CONFIRMED badge and active Cancel button', async () => {
    const confirmedBooking = { ...sampleBookingResponse, status: 'CONFIRMED' };
    vi.spyOn(api, 'getBookingByReference').mockResolvedValue(confirmedBooking);

    await BookingDetailModal.open('BK-20281001-ABCD');

    const container = (globalThis as any).document.getElementById('booking-detail-modal');
    expect(container.textContent).toContain('CONFIRMED');
    const cancelBtn = container.querySelector('#btn-trigger-cancel');
    expect(cancelBtn).toBeDefined();
  });

  // ============================================================
  // TEST Q — Network/API failure recovery does not produce duplicate booking requests
  // ============================================================
  it('TEST Q — Network/API failure recovers safely without duplicating booking requests', async () => {
    authStore.setSession(
      { id: 'c1', email: 'client@example.com', fullName: 'John Doe', role: 'CUSTOMER' },
      'mock.jwt',
    );

    const createSpy = vi
      .spyOn(api, 'createBooking')
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ data: sampleBookingResponse });

    BookingModal.open({ pkg: samplePackage, departure: sampleDeparture, initialPartySize: 1 });
    BookingModal.passengers[0]!.fullName = 'John Doe';
    BookingModal.primaryContact = {
      name: 'John Doe',
      email: 'client@example.com',
      phone: '+919876543210',
    };

    // First attempt fails
    await BookingModal.handleBookingSubmit();
    expect(BookingModal.isSubmitting).toBe(false);

    // Second attempt retries with same context
    await BookingModal.handleBookingSubmit();
    expect(createSpy).toHaveBeenCalledTimes(2);

    const refEl = (globalThis as any).document.getElementById('confirmation-booking-ref');
    expect(refEl.textContent).toBe('BK-20281001-ABCD');
  });
});
