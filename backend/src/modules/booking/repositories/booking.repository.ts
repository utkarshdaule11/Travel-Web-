import type pg from 'pg';
import { DatabaseService } from '../../../infrastructure/database/index.js';
import {
  BookingStatus,
  SupportedCurrency,
  PriceBreakdownSnapshot,
  PackageSnapshot,
  DepartureSnapshot,
  ItinerarySnapshot,
  PrimaryContactDto,
} from '../../../../../shared/src/index.js';

// ============================================================
// 1. Entity & Row Interfaces
// ============================================================

export interface BookingEntity {
  id: string;
  bookingReference: string;
  customerId: string;
  departureId: string;
  holdId: string | null;
  partySize: number;
  adultCount: number;
  childCount: number;
  totalPrice: number; // Minor units (paise/cents)
  currency: SupportedCurrency;
  status: BookingStatus;
  priceBreakdown: PriceBreakdownSnapshot;
  packageSnapshot: PackageSnapshot;
  departureSnapshot: DepartureSnapshot;
  itinerarySnapshot: ItinerarySnapshot;
  primaryContact: PrimaryContactDto;
  cancellationReason: string | null;
  cancelledAt: Date | null;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BookingSummaryEntity {
  id: string;
  bookingReference: string;
  customerId: string;
  departureId: string;
  partySize: number;
  adultCount: number;
  childCount: number;
  totalPrice: number;
  currency: SupportedCurrency;
  status: BookingStatus;
  primaryContact: PrimaryContactDto;
  packageTitle: string;
  departureDate: string; // YYYY-MM-DD
  returnDate: string; // YYYY-MM-DD
  createdAt: Date;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
}

export interface BookingRow {
  id: string;
  booking_reference: string;
  customer_id: string;
  departure_id: string;
  hold_id: string | null;
  party_size: number;
  adult_count: number;
  child_count: number;
  total_price: string | number;
  currency: string;
  status: string;
  price_breakdown: PriceBreakdownSnapshot | string;
  package_snapshot: PackageSnapshot | string;
  departure_snapshot: DepartureSnapshot | string;
  itinerary_snapshot: ItinerarySnapshot | string;
  primary_contact_name: string;
  primary_contact_email: string;
  primary_contact_phone: string;
  cancellation_reason: string | null;
  cancelled_at: Date | string | null;
  confirmed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface BookingSummaryRow {
  id: string;
  booking_reference: string;
  customer_id: string;
  departure_id: string;
  party_size: number;
  adult_count: number;
  child_count: number;
  total_price: string | number;
  currency: string;
  status: string;
  primary_contact_name: string;
  primary_contact_email: string;
  primary_contact_phone: string;
  package_title: string;
  departure_date: string | Date;
  return_date: string | Date;
  created_at: Date | string;
  confirmed_at: Date | string | null;
  cancelled_at: Date | string | null;
  total_count?: string | number;
}

export interface BookingListOptions {
  page?: number;
  limit?: number;
  status?: BookingStatus;
}

export interface BookingListResult {
  bookings: BookingSummaryEntity[];
  total: number;
}

export interface AdminBookingListOptions {
  page?: number;
  limit?: number;
  status?: BookingStatus;
  departureId?: string;
  customerId?: string;
  search?: string;
}

export interface AdminBookingListResult {
  bookings: BookingSummaryEntity[];
  total: number;
}

export interface CreateBookingData {
  id?: string;
  bookingReference: string;
  customerId: string;
  departureId: string;
  holdId?: string | null;
  partySize: number;
  adultCount: number;
  childCount: number;
  totalPrice: number; // Minor units
  currency: SupportedCurrency;
  status?: BookingStatus;
  priceBreakdown: PriceBreakdownSnapshot;
  packageSnapshot: PackageSnapshot;
  departureSnapshot: DepartureSnapshot;
  itinerarySnapshot: ItinerarySnapshot;
  primaryContact: PrimaryContactDto;
  cancellationReason?: string | null;
  cancelledAt?: Date | string | null;
  confirmedAt?: Date | string | null;
}

export interface ManifestPassengerRow {
  passenger_id: string;
  booking_reference: string;
  customer_name: string;
  customer_email: string;
  passenger_type: string;
  full_name: string;
  age_at_booking: number;
  gender: string;
  is_primary_contact: boolean;
  special_requests: string | null;
  booking_status: string;
}

export interface ManifestDepartureHeaderRow {
  departure_id: string;
  package_id: string;
  package_title: string;
  departure_date: string | Date;
  return_date: string | Date;
  total_seat_capacity: number;
  booked_seats: number;
}

export interface DepartureManifestEntity {
  departureId: string;
  packageId: string;
  packageTitle: string;
  departureDate: string;
  returnDate: string;
  totalCapacity: number;
  bookedSeats: number;
  totalPassengers: number;
  adultPassengers: number;
  childPassengers: number;
  passengers: Array<{
    passengerId: string;
    bookingReference: string;
    customerName: string;
    customerEmail: string;
    passengerType: 'ADULT' | 'CHILD';
    fullName: string;
    ageAtBooking: number;
    gender: 'MALE' | 'FEMALE' | 'OTHER';
    isPrimaryContact: boolean;
    specialRequests: string | null;
    bookingStatus: BookingStatus;
  }>;
}

// ============================================================
// 2. Explicit SQL Projections
// ============================================================

const BOOKING_PROJECTION = `
  id,
  booking_reference,
  customer_id,
  departure_id,
  hold_id,
  party_size,
  adult_count,
  child_count,
  total_price,
  currency,
  status,
  price_breakdown,
  package_snapshot,
  departure_snapshot,
  itinerary_snapshot,
  primary_contact_name,
  primary_contact_email,
  primary_contact_phone,
  cancellation_reason,
  cancelled_at,
  confirmed_at,
  created_at,
  updated_at
`;

function parseJsonField<T>(field: T | string): T {
  if (typeof field === 'string') {
    try {
      return JSON.parse(field) as T;
    } catch {
      return field as unknown as T;
    }
  }
  return field;
}

function formatDateOnly(d: string | Date): string {
  if (d instanceof Date) {
    return d.toISOString().split('T')[0] ?? '';
  }
  return String(d).split('T')[0] ?? '';
}

function mapRowToBookingEntity(row: BookingRow): BookingEntity {
  return {
    id: row.id,
    bookingReference: row.booking_reference,
    customerId: row.customer_id,
    departureId: row.departure_id,
    holdId: row.hold_id ?? null,
    partySize: Number(row.party_size),
    adultCount: Number(row.adult_count),
    childCount: Number(row.child_count),
    totalPrice: Number(row.total_price),
    currency: row.currency as SupportedCurrency,
    status: row.status as BookingStatus,
    priceBreakdown: parseJsonField<PriceBreakdownSnapshot>(row.price_breakdown),
    packageSnapshot: parseJsonField<PackageSnapshot>(row.package_snapshot),
    departureSnapshot: parseJsonField<DepartureSnapshot>(row.departure_snapshot),
    itinerarySnapshot: parseJsonField<ItinerarySnapshot>(row.itinerary_snapshot),
    primaryContact: {
      name: row.primary_contact_name,
      email: row.primary_contact_email,
      phone: row.primary_contact_phone,
    },
    cancellationReason: row.cancellation_reason ?? null,
    cancelledAt: row.cancelled_at
      ? row.cancelled_at instanceof Date
        ? row.cancelled_at
        : new Date(row.cancelled_at)
      : null,
    confirmedAt: row.confirmed_at
      ? row.confirmed_at instanceof Date
        ? row.confirmed_at
        : new Date(row.confirmed_at)
      : null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

function mapRowToSummaryEntity(row: BookingSummaryRow): BookingSummaryEntity {
  return {
    id: row.id,
    bookingReference: row.booking_reference,
    customerId: row.customer_id,
    departureId: row.departure_id,
    partySize: Number(row.party_size),
    adultCount: Number(row.adult_count),
    childCount: Number(row.child_count),
    totalPrice: Number(row.total_price),
    currency: row.currency as SupportedCurrency,
    status: row.status as BookingStatus,
    primaryContact: {
      name: row.primary_contact_name,
      email: row.primary_contact_email,
      phone: row.primary_contact_phone,
    },
    packageTitle: row.package_title,
    departureDate: formatDateOnly(row.departure_date),
    returnDate: formatDateOnly(row.return_date),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    confirmedAt: row.confirmed_at
      ? row.confirmed_at instanceof Date
        ? row.confirmed_at
        : new Date(row.confirmed_at)
      : null,
    cancelledAt: row.cancelled_at
      ? row.cancelled_at instanceof Date
        ? row.cancelled_at
        : new Date(row.cancelled_at)
      : null,
  };
}

// ============================================================
// 3. BookingRepository Class
// ============================================================

export class BookingRepository {
  constructor(private readonly db: DatabaseService) {}

  private getExecutor(client?: pg.PoolClient): {
    query: <R extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      params?: unknown[],
    ) => Promise<pg.QueryResult<R>>;
  } {
    return client ?? this.db;
  }

  /**
   * Persists a new booking record with immutable snapshots.
   * Parameterized and transaction-safe.
   */
  async create(data: CreateBookingData, client?: pg.PoolClient): Promise<BookingEntity> {
    const executor = this.getExecutor(client);
    const sql = `
      INSERT INTO bookings (
        booking_reference,
        customer_id,
        departure_id,
        hold_id,
        party_size,
        adult_count,
        child_count,
        total_price,
        currency,
        status,
        price_breakdown,
        package_snapshot,
        departure_snapshot,
        itinerary_snapshot,
        primary_contact_name,
        primary_contact_email,
        primary_contact_phone,
        cancellation_reason,
        cancelled_at,
        confirmed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
      )
      RETURNING ${BOOKING_PROJECTION};
    `;

    const values = [
      data.bookingReference,
      data.customerId,
      data.departureId,
      data.holdId ?? null,
      data.partySize,
      data.adultCount,
      data.childCount,
      data.totalPrice,
      data.currency,
      data.status ?? 'AWAITING_PAYMENT',
      JSON.stringify(data.priceBreakdown),
      JSON.stringify(data.packageSnapshot),
      JSON.stringify(data.departureSnapshot),
      JSON.stringify(data.itinerarySnapshot),
      data.primaryContact.name,
      data.primaryContact.email,
      data.primaryContact.phone,
      data.cancellationReason ?? null,
      data.cancelledAt ?? null,
      data.confirmedAt ?? null,
    ];

    const result = await executor.query<BookingRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create booking: no row returned');
    }
    return mapRowToBookingEntity(row);
  }

  /**
   * Finds a booking by internal UUID.
   */
  async findById(id: string, client?: pg.PoolClient): Promise<BookingEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${BOOKING_PROJECTION}
      FROM bookings
      WHERE id = $1;
    `;

    const result = await executor.query<BookingRow>(sql, [id]);
    const row = result.rows[0];
    return row ? mapRowToBookingEntity(row) : null;
  }

  /**
   * Finds a booking by associated inventory hold ID.
   */
  async findByHoldId(holdId: string, client?: pg.PoolClient): Promise<BookingEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${BOOKING_PROJECTION}
      FROM bookings
      WHERE hold_id = $1;
    `;

    const result = await executor.query<BookingRow>(sql, [holdId]);
    const row = result.rows[0];
    return row ? mapRowToBookingEntity(row) : null;
  }

  /**
   * Finds a booking by human-readable reference (e.g. BK-20261115-A8F2).
   */
  async findByReference(reference: string, client?: pg.PoolClient): Promise<BookingEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${BOOKING_PROJECTION}
      FROM bookings
      WHERE booking_reference = $1;
    `;

    const result = await executor.query<BookingRow>(sql, [reference]);
    const row = result.rows[0];
    return row ? mapRowToBookingEntity(row) : null;
  }

  /**
   * Finds a booking by reference with customer ID ownership guard (prevents IDOR).
   */
  async findByReferenceAndCustomer(
    reference: string,
    customerId: string,
    client?: pg.PoolClient,
  ): Promise<BookingEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${BOOKING_PROJECTION}
      FROM bookings
      WHERE booking_reference = $1
        AND customer_id = $2;
    `;

    const result = await executor.query<BookingRow>(sql, [reference, customerId]);
    const row = result.rows[0];
    return row ? mapRowToBookingEntity(row) : null;
  }

  /**
   * Retrieves paginated bookings for a customer.
   */
  async findByCustomerId(
    customerId: string,
    options: { page?: number; limit?: number; status?: BookingStatus } = {},
    client?: pg.PoolClient,
  ): Promise<{ bookings: BookingSummaryEntity[]; total: number }> {
    const executor = this.getExecutor(client);
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['b.customer_id = $1'];
    const values: unknown[] = [customerId];

    if (options.status) {
      conditions.push(`b.status = $${values.length + 1}`);
      values.push(options.status);
    }

    const whereClause = conditions.join(' AND ');

    const sql = `
      SELECT
        b.id,
        b.booking_reference,
        b.customer_id,
        b.departure_id,
        b.party_size,
        b.adult_count,
        b.child_count,
        b.total_price,
        b.currency,
        b.status,
        b.primary_contact_name,
        b.primary_contact_email,
        b.primary_contact_phone,
        tp.title AS package_title,
        ds.departure_date,
        ds.return_date,
        b.created_at,
        b.confirmed_at,
        b.cancelled_at,
        COUNT(*) OVER()::integer AS total_count
      FROM bookings b
      JOIN departure_schedules ds ON b.departure_id = ds.id
      JOIN tour_packages tp ON ds.package_id = tp.id
      WHERE ${whereClause}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2};
    `;

    values.push(limit, offset);

    const result = await executor.query<BookingSummaryRow>(sql, values);
    const total = Number(result.rows[0]?.total_count ?? 0);
    const bookings = result.rows.map(mapRowToSummaryEntity);

    return { bookings, total };
  }

  /**
   * Admin booking query supporting filters and deterministic pagination.
   */
  async listAdmin(
    options: {
      page?: number;
      limit?: number;
      status?: BookingStatus;
      departureId?: string;
      customerId?: string;
      search?: string;
    } = {},
    client?: pg.PoolClient,
  ): Promise<{ bookings: BookingSummaryEntity[]; total: number }> {
    const executor = this.getExecutor(client);
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['1=1'];
    const values: unknown[] = [];

    if (options.status) {
      conditions.push(`b.status = $${values.length + 1}`);
      values.push(options.status);
    }

    if (options.departureId) {
      conditions.push(`b.departure_id = $${values.length + 1}`);
      values.push(options.departureId);
    }

    if (options.customerId) {
      conditions.push(`b.customer_id = $${values.length + 1}`);
      values.push(options.customerId);
    }

    if (options.search) {
      const searchPattern = `%${options.search.trim()}%`;
      conditions.push(
        `(b.booking_reference ILIKE $${values.length + 1} OR b.primary_contact_name ILIKE $${values.length + 1} OR b.primary_contact_email ILIKE $${values.length + 1})`,
      );
      values.push(searchPattern);
    }

    const whereClause = conditions.join(' AND ');

    const sql = `
      SELECT
        b.id,
        b.booking_reference,
        b.customer_id,
        b.departure_id,
        b.party_size,
        b.adult_count,
        b.child_count,
        b.total_price,
        b.currency,
        b.status,
        b.primary_contact_name,
        b.primary_contact_email,
        b.primary_contact_phone,
        tp.title AS package_title,
        ds.departure_date,
        ds.return_date,
        b.created_at,
        b.confirmed_at,
        b.cancelled_at,
        COUNT(*) OVER()::integer AS total_count
      FROM bookings b
      JOIN departure_schedules ds ON b.departure_id = ds.id
      JOIN tour_packages tp ON ds.package_id = tp.id
      WHERE ${whereClause}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2};
    `;

    values.push(limit, offset);

    const result = await executor.query<BookingSummaryRow>(sql, values);
    const total = Number(result.rows[0]?.total_count ?? 0);
    const bookings = result.rows.map(mapRowToSummaryEntity);

    return { bookings, total };
  }

  /**
   * Atomic state transition primitive guarded by expected current status.
   * Prevents race conditions and double transitions.
   */
  async updateStatusGuarded(
    id: string,
    expectedCurrentStatus: BookingStatus,
    nextStatus: BookingStatus,
    metadata: {
      cancellationReason?: string | null;
      cancelledAt?: Date | string | null;
      confirmedAt?: Date | string | null;
    } = {},
    client?: pg.PoolClient,
  ): Promise<BookingEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      UPDATE bookings
      SET
        status = $3,
        cancellation_reason = COALESCE($4, cancellation_reason),
        cancelled_at = COALESCE($5, cancelled_at),
        confirmed_at = COALESCE($6, confirmed_at),
        updated_at = NOW()
      WHERE id = $1
        AND status = $2
      RETURNING ${BOOKING_PROJECTION};
    `;

    const values = [
      id,
      expectedCurrentStatus,
      nextStatus,
      metadata.cancellationReason ?? null,
      metadata.cancelledAt ?? null,
      metadata.confirmedAt ?? null,
    ];

    const result = await executor.query<BookingRow>(sql, values);
    const row = result.rows[0];
    return row ? mapRowToBookingEntity(row) : null;
  }

  /**
   * Retrieves departure passenger manifest aggregating departure info and passenger roster.
   */
  async findDepartureManifest(
    departureId: string,
    client?: pg.PoolClient,
  ): Promise<DepartureManifestEntity | null> {
    const executor = this.getExecutor(client);

    // 1. Fetch Departure & Package Header
    const headerSql = `
      SELECT
        ds.id AS departure_id,
        tp.id AS package_id,
        tp.title AS package_title,
        ds.departure_date,
        ds.return_date,
        ds.total_seat_capacity,
        ds.booked_seats
      FROM departure_schedules ds
      JOIN tour_packages tp ON ds.package_id = tp.id
      WHERE ds.id = $1;
    `;

    const headerResult = await executor.query<ManifestDepartureHeaderRow>(headerSql, [departureId]);
    const header = headerResult.rows[0];
    if (!header) {
      return null;
    }

    // 2. Fetch Manifest Passengers (CONFIRMED bookings only)
    const passengersSql = `
      SELECT
        bp.id AS passenger_id,
        b.booking_reference,
        u.full_name AS customer_name,
        u.email AS customer_email,
        bp.passenger_type,
        bp.full_name,
        bp.age_at_booking,
        bp.gender,
        bp.is_primary_contact,
        bp.special_requests,
        b.status AS booking_status
      FROM booking_passengers bp
      JOIN bookings b ON bp.booking_id = b.id
      JOIN users u ON b.customer_id = u.id
      WHERE b.departure_id = $1
        AND b.status = 'CONFIRMED'
      ORDER BY b.booking_reference ASC, bp.is_primary_contact DESC, bp.created_at ASC;
    `;

    const passengerResult = await executor.query<ManifestPassengerRow>(passengersSql, [
      departureId,
    ]);
    const passengers = passengerResult.rows.map((r) => ({
      passengerId: r.passenger_id,
      bookingReference: r.booking_reference,
      customerName: r.customer_name,
      customerEmail: r.customer_email,
      passengerType: r.passenger_type as 'ADULT' | 'CHILD',
      fullName: r.full_name,
      ageAtBooking: Number(r.age_at_booking),
      gender: r.gender as 'MALE' | 'FEMALE' | 'OTHER',
      isPrimaryContact: Boolean(r.is_primary_contact),
      specialRequests: r.special_requests ?? null,
      bookingStatus: r.booking_status as BookingStatus,
    }));

    const adultPassengers = passengers.filter((p) => p.passengerType === 'ADULT').length;
    const childPassengers = passengers.filter((p) => p.passengerType === 'CHILD').length;

    return {
      departureId: header.departure_id,
      packageId: header.package_id,
      packageTitle: header.package_title,
      departureDate: formatDateOnly(header.departure_date),
      returnDate: formatDateOnly(header.return_date),
      totalCapacity: Number(header.total_seat_capacity),
      bookedSeats: Number(header.booked_seats),
      totalPassengers: passengers.length,
      adultPassengers,
      childPassengers,
      passengers,
    };
  }
}
