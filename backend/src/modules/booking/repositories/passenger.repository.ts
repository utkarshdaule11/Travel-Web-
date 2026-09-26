import type pg from 'pg';
import { DatabaseService } from '../../../infrastructure/database/index.js';
import { PassengerType, PassengerGender } from '../../../../../shared/src/index.js';

// ============================================================
// 1. Entity & Row Interfaces
// ============================================================

export interface PassengerEntity {
  id: string;
  bookingId: string;
  passengerType: PassengerType;
  fullName: string;
  dateOfBirth: string | null; // YYYY-MM-DD
  ageAtBooking: number;
  gender: PassengerGender;
  isPrimaryContact: boolean;
  specialRequests: string | null;
  createdAt: Date;
}

export interface PassengerRow {
  id: string;
  booking_id: string;
  passenger_type: string;
  full_name: string;
  date_of_birth: string | Date | null;
  age_at_booking: number;
  gender: string;
  is_primary_contact: boolean;
  special_requests: string | null;
  created_at: Date | string;
}

export interface CreatePassengerData {
  id?: string;
  bookingId: string;
  passengerType: PassengerType;
  fullName: string;
  dateOfBirth?: string | Date | null;
  ageAtBooking: number;
  gender: PassengerGender;
  isPrimaryContact?: boolean;
  specialRequests?: string | null;
}

// ============================================================
// 2. Explicit SQL Projections
// ============================================================

const PASSENGER_PROJECTION = `
  id,
  booking_id,
  passenger_type,
  full_name,
  date_of_birth,
  age_at_booking,
  gender,
  is_primary_contact,
  special_requests,
  created_at
`;

function formatDateOnly(d: string | Date | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    return d.toISOString().split('T')[0] ?? null;
  }
  return String(d).split('T')[0] ?? null;
}

function mapRowToPassengerEntity(row: PassengerRow): PassengerEntity {
  return {
    id: row.id,
    bookingId: row.booking_id,
    passengerType: row.passenger_type as PassengerType,
    fullName: row.full_name,
    dateOfBirth: formatDateOnly(row.date_of_birth),
    ageAtBooking: Number(row.age_at_booking),
    gender: row.gender as PassengerGender,
    isPrimaryContact: Boolean(row.is_primary_contact),
    specialRequests: row.special_requests ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

// ============================================================
// 3. PassengerRepository Class
// ============================================================

export class PassengerRepository {
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
   * Persists a single passenger record.
   */
  async create(data: CreatePassengerData, client?: pg.PoolClient): Promise<PassengerEntity> {
    const executor = this.getExecutor(client);
    const sql = `
      INSERT INTO booking_passengers (
        booking_id,
        passenger_type,
        full_name,
        date_of_birth,
        age_at_booking,
        gender,
        is_primary_contact,
        special_requests
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING ${PASSENGER_PROJECTION};
    `;

    const values = [
      data.bookingId,
      data.passengerType,
      data.fullName,
      data.dateOfBirth ?? null,
      data.ageAtBooking,
      data.gender,
      data.isPrimaryContact ?? false,
      data.specialRequests ?? null,
    ];

    const result = await executor.query<PassengerRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create passenger: no row returned');
    }
    return mapRowToPassengerEntity(row);
  }

  /**
   * Persists multiple passenger records atomically in parameterized multi-row insert.
   */
  async createMany(
    passengers: CreatePassengerData[],
    client?: pg.PoolClient,
  ): Promise<PassengerEntity[]> {
    if (passengers.length === 0) {
      return [];
    }

    const executor = this.getExecutor(client);
    const values: unknown[] = [];
    const valueTuples: string[] = [];

    passengers.forEach((p, index) => {
      const offset = index * 8;
      valueTuples.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`,
      );
      values.push(
        p.bookingId,
        p.passengerType,
        p.fullName,
        p.dateOfBirth ?? null,
        p.ageAtBooking,
        p.gender,
        p.isPrimaryContact ?? false,
        p.specialRequests ?? null,
      );
    });

    const sql = `
      INSERT INTO booking_passengers (
        booking_id,
        passenger_type,
        full_name,
        date_of_birth,
        age_at_booking,
        gender,
        is_primary_contact,
        special_requests
      ) VALUES ${valueTuples.join(', ')}
      RETURNING ${PASSENGER_PROJECTION};
    `;

    const result = await executor.query<PassengerRow>(sql, values);
    return result.rows.map(mapRowToPassengerEntity);
  }

  /**
   * Retrieves all passengers for a given booking ID.
   */
  async findByBookingId(bookingId: string, client?: pg.PoolClient): Promise<PassengerEntity[]> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${PASSENGER_PROJECTION}
      FROM booking_passengers
      WHERE booking_id = $1
      ORDER BY is_primary_contact DESC, created_at ASC;
    `;

    const result = await executor.query<PassengerRow>(sql, [bookingId]);
    return result.rows.map(mapRowToPassengerEntity);
  }
}
