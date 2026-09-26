import type pg from 'pg';
import { DatabaseService } from '../../../infrastructure/database/index.js';
import { DepartureStatus, SupportedCurrency } from '../../../../../shared/src/index.js';

// ============================================================
// 1. Data Transfer & Entity Interfaces
// ============================================================

export interface DepartureEntity {
  id: string;
  packageId: string;
  departureDate: string; // ISO date YYYY-MM-DD
  returnDate: string; // ISO date YYYY-MM-DD
  totalSeatCapacity: number;
  bookedSeats: number;
  priceOverrideAdult: number | null; // Minor units (paise/cents)
  priceOverrideChild: number | null; // Minor units (paise/cents)
  currency: SupportedCurrency | null;
  status: DepartureStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface DepartureRow {
  id: string;
  package_id: string;
  departure_date: string | Date;
  return_date: string | Date;
  total_seat_capacity: number;
  booked_seats: number;
  price_override_adult: string | number | null;
  price_override_child: string | number | null;
  currency: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CreateDepartureData {
  packageId: string;
  departureDate: string;
  returnDate: string;
  totalSeatCapacity: number;
  priceOverrideAdult?: number | null;
  priceOverrideChild?: number | null;
  currency?: SupportedCurrency | null;
  status?: DepartureStatus;
}

export interface UpdateDepartureData {
  departureDate?: string;
  returnDate?: string;
  totalSeatCapacity?: number;
  priceOverrideAdult?: number | null;
  priceOverrideChild?: number | null;
  currency?: SupportedCurrency | null;
  status?: DepartureStatus;
}

export interface DepartureAvailabilityAggregateRow {
  id: string;
  package_id: string;
  departure_date: string | Date;
  return_date: string | Date;
  total_seat_capacity: number;
  booked_seats: number;
  price_override_adult: string | number | null;
  price_override_child: string | number | null;
  departure_currency: string | null;
  departure_status: string;
  active_held_seats: string | number;
  available_seats: string | number;
  base_adult_price: string | number;
  base_child_price: string | number;
  package_currency: string;
}

export interface DepartureAvailabilityAggregate {
  departureId: string;
  packageId: string;
  departureDate: string;
  returnDate: string;
  totalSeatCapacity: number;
  bookedSeats: number;
  activeHeldSeats: number;
  availableSeats: number;
  priceOverrideAdult: number | null;
  priceOverrideChild: number | null;
  departureCurrency: SupportedCurrency | null;
  departureStatus: DepartureStatus;
  baseAdultPrice: number;
  baseChildPrice: number;
  packageCurrency: SupportedCurrency;
}

export interface DepartureListOptions {
  status?: DepartureStatus;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}

// Explicit projection for departure_schedules queries
const DEPARTURE_PROJECTION = `
  id,
  package_id,
  departure_date::text AS departure_date,
  return_date::text AS return_date,
  total_seat_capacity,
  booked_seats,
  price_override_adult,
  price_override_child,
  currency,
  status,
  created_at,
  updated_at
`;

function formatDateString(val: string | Date): string {
  if (val instanceof Date) {
    return val.toISOString().split('T')[0] ?? '';
  }
  return typeof val === 'string' ? (val.split('T')[0] ?? val) : String(val);
}

function mapRowToDepartureEntity(row: DepartureRow): DepartureEntity {
  return {
    id: row.id,
    packageId: row.package_id,
    departureDate: formatDateString(row.departure_date),
    returnDate: formatDateString(row.return_date),
    totalSeatCapacity: Number(row.total_seat_capacity),
    bookedSeats: Number(row.booked_seats),
    priceOverrideAdult:
      row.price_override_adult !== null && row.price_override_adult !== undefined
        ? Number(row.price_override_adult)
        : null,
    priceOverrideChild:
      row.price_override_child !== null && row.price_override_child !== undefined
        ? Number(row.price_override_child)
        : null,
    currency: (row.currency as SupportedCurrency) ?? null,
    status: row.status as DepartureStatus,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

// ============================================================
// 2. DepartureRepository Class
// ============================================================

export class DepartureRepository {
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
   * Create a new departure schedule record in PostgreSQL.
   */
  async create(data: CreateDepartureData, client?: pg.PoolClient): Promise<DepartureEntity> {
    const executor = this.getExecutor(client);
    const sql = `
      INSERT INTO departure_schedules (
        package_id,
        departure_date,
        return_date,
        total_seat_capacity,
        price_override_adult,
        price_override_child,
        currency,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING ${DEPARTURE_PROJECTION};
    `;

    const values = [
      data.packageId,
      data.departureDate,
      data.returnDate,
      data.totalSeatCapacity,
      data.priceOverrideAdult ?? null,
      data.priceOverrideChild ?? null,
      data.currency ?? null,
      data.status ?? 'OPEN',
    ];

    const result = await executor.query<DepartureRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create departure schedule: no row returned');
    }
    return mapRowToDepartureEntity(row);
  }

  /**
   * Find a departure schedule by its primary key UUID.
   */
  async findById(id: string, client?: pg.PoolClient): Promise<DepartureEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${DEPARTURE_PROJECTION}
      FROM departure_schedules
      WHERE id = $1;
    `;

    const result = await executor.query<DepartureRow>(sql, [id]);
    const row = result.rows[0];
    return row ? mapRowToDepartureEntity(row) : null;
  }

  /**
   * Acquire exclusive row-level lock (FOR UPDATE) within a caller-managed transaction.
   * Crucial for atomic concurrency and seat allocation safety (NFR-REL-001).
   */
  async findByIdForUpdate(id: string, client: pg.PoolClient): Promise<DepartureEntity | null> {
    const sql = `
      SELECT ${DEPARTURE_PROJECTION}
      FROM departure_schedules
      WHERE id = $1
      FOR UPDATE;
    `;

    const result = await client.query<DepartureRow>(sql, [id]);
    const row = result.rows[0];
    return row ? mapRowToDepartureEntity(row) : null;
  }

  /**
   * List all departures for a specific tour package with optional status and date filters.
   * Deterministically ordered by departure_date ASC, id ASC.
   */
  async listByPackageId(
    packageId: string,
    options: DepartureListOptions = {},
    client?: pg.PoolClient,
  ): Promise<DepartureEntity[]> {
    const executor = this.getExecutor(client);
    const conditions: string[] = ['package_id = $1'];
    const values: unknown[] = [packageId];
    let paramIndex = 2;

    if (options.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(options.status);
    }

    if (options.fromDate) {
      conditions.push(`departure_date >= $${paramIndex++}`);
      values.push(options.fromDate);
    }

    if (options.toDate) {
      conditions.push(`departure_date <= $${paramIndex++}`);
      values.push(options.toDate);
    }

    const whereSql = `WHERE ${conditions.join(' AND ')}`;
    let paginationSql = '';

    if (options.limit !== undefined) {
      const page = Math.max(1, options.page ?? 1);
      const limit = Math.max(1, options.limit);
      const offset = (page - 1) * limit;
      paginationSql = ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      values.push(limit, offset);
    }

    const sql = `
      SELECT ${DEPARTURE_PROJECTION}
      FROM departure_schedules
      ${whereSql}
      ORDER BY departure_date ASC, id ASC
      ${paginationSql};
    `;

    const result = await executor.query<DepartureRow>(sql, values);
    return result.rows.map(mapRowToDepartureEntity);
  }

  /**
   * List open, upcoming departures for customer calendar selection on storefront.
   */
  async listUpcomingForPackage(
    packageId: string,
    fromDate?: string,
    client?: pg.PoolClient,
  ): Promise<DepartureEntity[]> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${DEPARTURE_PROJECTION}
      FROM departure_schedules
      WHERE package_id = $1
        AND status = 'OPEN'
        AND departure_date >= COALESCE($2::date, CURRENT_DATE)
      ORDER BY departure_date ASC, id ASC;
    `;

    const result = await executor.query<DepartureRow>(sql, [packageId, fromDate ?? null]);
    return result.rows.map(mapRowToDepartureEntity);
  }

  /**
   * Perform dynamic partial update on a departure schedule.
   * Strictly validates parameters and updates updated_at timestamp.
   */
  async update(
    id: string,
    data: UpdateDepartureData,
    client?: pg.PoolClient,
  ): Promise<DepartureEntity | null> {
    const executor = this.getExecutor(client);
    const setClauses: string[] = [];
    const values: unknown[] = [id];
    let paramIndex = 2;

    if (data.departureDate !== undefined) {
      setClauses.push(`departure_date = $${paramIndex++}`);
      values.push(data.departureDate);
    }

    if (data.returnDate !== undefined) {
      setClauses.push(`return_date = $${paramIndex++}`);
      values.push(data.returnDate);
    }

    if (data.totalSeatCapacity !== undefined) {
      setClauses.push(`total_seat_capacity = $${paramIndex++}`);
      values.push(data.totalSeatCapacity);
    }

    if (data.priceOverrideAdult !== undefined) {
      setClauses.push(`price_override_adult = $${paramIndex++}`);
      values.push(data.priceOverrideAdult);
    }

    if (data.priceOverrideChild !== undefined) {
      setClauses.push(`price_override_child = $${paramIndex++}`);
      values.push(data.priceOverrideChild);
    }

    if (data.currency !== undefined) {
      setClauses.push(`currency = $${paramIndex++}`);
      values.push(data.currency);
    }

    if (data.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(data.status);
    }

    if (setClauses.length === 0) {
      return this.findById(id, client);
    }

    setClauses.push(`updated_at = NOW()`);

    const sql = `
      UPDATE departure_schedules
      SET ${setClauses.join(', ')}
      WHERE id = $1
      RETURNING ${DEPARTURE_PROJECTION};
    `;

    const result = await executor.query<DepartureRow>(sql, values);
    const row = result.rows[0];
    return row ? mapRowToDepartureEntity(row) : null;
  }

  /**
   * Increment confirmed booked seats on a departure schedule.
   * Caller must ensure total_seat_capacity bound constraint is not violated.
   */
  async incrementBookedSeats(
    id: string,
    seatCount: number,
    client: pg.PoolClient,
  ): Promise<DepartureEntity | null> {
    const sql = `
      UPDATE departure_schedules
      SET booked_seats = booked_seats + $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${DEPARTURE_PROJECTION};
    `;

    const result = await client.query<DepartureRow>(sql, [id, seatCount]);
    const row = result.rows[0];
    return row ? mapRowToDepartureEntity(row) : null;
  }

  /**
   * Decrement confirmed booked seats on a departure schedule upon booking cancellation.
   * Atomically enforces booked_seats >= seatCount invariant (prevents masking inventory corruption).
   */
  async decrementBookedSeats(
    id: string,
    seatCount: number,
    client: pg.PoolClient,
  ): Promise<DepartureEntity | null> {
    const sql = `
      UPDATE departure_schedules
      SET booked_seats = booked_seats - $2,
          updated_at = NOW()
      WHERE id = $1 AND booked_seats >= $2
      RETURNING ${DEPARTURE_PROJECTION};
    `;

    const result = await client.query<DepartureRow>(sql, [id, seatCount]);
    const row = result.rows[0];
    return row ? mapRowToDepartureEntity(row) : null;
  }

  /**
   * Delete a departure schedule if no bookings exist.
   */
  async delete(id: string, client?: pg.PoolClient): Promise<boolean> {
    const executor = this.getExecutor(client);
    const sql = `
      DELETE FROM departure_schedules
      WHERE id = $1 AND booked_seats = 0;
    `;

    const result = await executor.query(sql, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Count total departures for a package.
   */
  async countByPackageId(packageId: string, client?: pg.PoolClient): Promise<number> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT COUNT(*)::text AS count
      FROM departure_schedules
      WHERE package_id = $1;
    `;

    const result = await executor.query<{ count: string }>(sql, [packageId]);
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Aggregate live availability data for a departure in real-time.
   * Formula: available_seats = MAX(0, total_seat_capacity - (booked_seats + SUM(active_unexpired_holds))).
   * Does NOT persist or mutate seat availability columns.
   */
  async getAvailabilityById(
    departureId: string,
    client?: pg.PoolClient,
  ): Promise<DepartureAvailabilityAggregate | null> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT
        ds.id,
        ds.package_id,
        ds.departure_date::text AS departure_date,
        ds.return_date::text AS return_date,
        ds.total_seat_capacity,
        ds.booked_seats,
        ds.price_override_adult,
        ds.price_override_child,
        ds.currency AS departure_currency,
        ds.status AS departure_status,
        COALESCE(SUM(ih.held_seats), 0)::integer AS active_held_seats,
        GREATEST(
          0,
          ds.total_seat_capacity - ds.booked_seats - COALESCE(SUM(ih.held_seats), 0)
        )::integer AS available_seats,
        tp.base_adult_price,
        tp.base_child_price,
        tp.currency AS package_currency
      FROM departure_schedules ds
      JOIN tour_packages tp ON ds.package_id = tp.id
      LEFT JOIN inventory_holds ih ON ds.id = ih.departure_id
        AND ih.status = 'ACTIVE'
        AND ih.expires_at > NOW()
      WHERE ds.id = $1
      GROUP BY
        ds.id,
        ds.package_id,
        ds.departure_date,
        ds.return_date,
        ds.total_seat_capacity,
        ds.booked_seats,
        ds.price_override_adult,
        ds.price_override_child,
        ds.currency,
        ds.status,
        tp.base_adult_price,
        tp.base_child_price,
        tp.currency;
    `;

    const result = await executor.query<DepartureAvailabilityAggregateRow>(sql, [departureId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      departureId: row.id,
      packageId: row.package_id,
      departureDate: formatDateString(row.departure_date),
      returnDate: formatDateString(row.return_date),
      totalSeatCapacity: Number(row.total_seat_capacity),
      bookedSeats: Number(row.booked_seats),
      activeHeldSeats: Number(row.active_held_seats),
      availableSeats: Number(row.available_seats),
      priceOverrideAdult:
        row.price_override_adult !== null && row.price_override_adult !== undefined
          ? Number(row.price_override_adult)
          : null,
      priceOverrideChild:
        row.price_override_child !== null && row.price_override_child !== undefined
          ? Number(row.price_override_child)
          : null,
      departureCurrency: (row.departure_currency as SupportedCurrency) ?? null,
      departureStatus: row.departure_status as DepartureStatus,
      baseAdultPrice: Number(row.base_adult_price),
      baseChildPrice: Number(row.base_child_price),
      packageCurrency: row.package_currency as SupportedCurrency,
    };
  }
}
