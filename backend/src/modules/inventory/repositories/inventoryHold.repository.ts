import type pg from 'pg';
import { DatabaseService } from '../../../infrastructure/database/index.js';
import { InventoryHoldStatus } from '../../../../../shared/src/index.js';

// ============================================================
// 1. Data Transfer & Entity Interfaces
// ============================================================

export interface InventoryHoldEntity {
  id: string;
  departureId: string;
  checkoutSessionToken: string;
  userId: string | null;
  heldSeats: number;
  status: InventoryHoldStatus;
  expiresAt: Date;
  createdAt: Date;
}

export interface InventoryHoldRow {
  id: string;
  departure_id: string;
  checkout_session_token: string;
  user_id: string | null;
  held_seats: number;
  status: string;
  expires_at: Date | string;
  created_at: Date | string;
}

export interface CreateHoldData {
  departureId: string;
  checkoutSessionToken: string;
  userId?: string | null;
  heldSeats: number;
  status?: InventoryHoldStatus;
  expiresAt: Date | string;
}

const HOLD_PROJECTION = `
  id,
  departure_id,
  checkout_session_token,
  user_id,
  held_seats,
  status,
  expires_at,
  created_at
`;

function mapRowToHoldEntity(row: InventoryHoldRow): InventoryHoldEntity {
  return {
    id: row.id,
    departureId: row.departure_id,
    checkoutSessionToken: row.checkout_session_token,
    userId: row.user_id,
    heldSeats: Number(row.held_seats),
    status: row.status as InventoryHoldStatus,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

// ============================================================
// 2. InventoryHoldRepository Class
// ============================================================

export class InventoryHoldRepository {
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
   * Insert a temporary seat hold into inventory_holds.
   * Parameterized and transaction-safe.
   */
  async create(data: CreateHoldData, client?: pg.PoolClient): Promise<InventoryHoldEntity> {
    const executor = this.getExecutor(client);
    const sql = `
      INSERT INTO inventory_holds (
        departure_id,
        checkout_session_token,
        user_id,
        held_seats,
        status,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING ${HOLD_PROJECTION};
    `;

    const values = [
      data.departureId,
      data.checkoutSessionToken,
      data.userId ?? null,
      data.heldSeats,
      data.status ?? 'ACTIVE',
      data.expiresAt,
    ];

    const result = await executor.query<InventoryHoldRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create inventory hold: no row returned');
    }
    return mapRowToHoldEntity(row);
  }

  /**
   * Find an inventory hold by ID.
   */
  async findById(id: string, client?: pg.PoolClient): Promise<InventoryHoldEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${HOLD_PROJECTION}
      FROM inventory_holds
      WHERE id = $1;
    `;

    const result = await executor.query<InventoryHoldRow>(sql, [id]);
    const row = result.rows[0];
    return row ? mapRowToHoldEntity(row) : null;
  }

  /**
   * Find an inventory hold by unique checkout session token.
   */
  async findBySessionToken(
    checkoutSessionToken: string,
    client?: pg.PoolClient,
  ): Promise<InventoryHoldEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${HOLD_PROJECTION}
      FROM inventory_holds
      WHERE checkout_session_token = $1;
    `;

    const result = await executor.query<InventoryHoldRow>(sql, [checkoutSessionToken]);
    const row = result.rows[0];
    return row ? mapRowToHoldEntity(row) : null;
  }

  /**
   * Sum total active and unexpired held seats for a departure.
   * PostgreSQL time (NOW()) ensures consistent multi-server time evaluation.
   */
  async getActiveHoldCountForDeparture(
    departureId: string,
    client?: pg.PoolClient,
  ): Promise<number> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT COALESCE(SUM(held_seats), 0)::integer AS active_held_seats
      FROM inventory_holds
      WHERE departure_id = $1
        AND status = 'ACTIVE'
        AND expires_at > NOW();
    `;

    const result = await executor.query<{ active_held_seats: number }>(sql, [departureId]);
    return Number(result.rows[0]?.active_held_seats ?? 0);
  }

  /**
   * List all holds for a departure, with optional status filter.
   */
  async listByDepartureId(
    departureId: string,
    options: { status?: InventoryHoldStatus } = {},
    client?: pg.PoolClient,
  ): Promise<InventoryHoldEntity[]> {
    const executor = this.getExecutor(client);
    const conditions: string[] = ['departure_id = $1'];
    const values: unknown[] = [departureId];

    if (options.status) {
      conditions.push('status = $2');
      values.push(options.status);
    }

    const sql = `
      SELECT ${HOLD_PROJECTION}
      FROM inventory_holds
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC;
    `;

    const result = await executor.query<InventoryHoldRow>(sql, values);
    return result.rows.map(mapRowToHoldEntity);
  }

  /**
   * Acquire exclusive row-level lock on an inventory hold within a transaction.
   */
  async findByIdForUpdate(id: string, client: pg.PoolClient): Promise<InventoryHoldEntity | null> {
    const sql = `
      SELECT ${HOLD_PROJECTION}
      FROM inventory_holds
      WHERE id = $1
      FOR UPDATE;
    `;

    const result = await client.query<InventoryHoldRow>(sql, [id]);
    const row = result.rows[0];
    return row ? mapRowToHoldEntity(row) : null;
  }

  /**
   * Update the status of a hold (e.g. to COMMITTED, EXPIRED, or RELEASED).
   */
  async updateStatus(
    id: string,
    status: InventoryHoldStatus,
    client?: pg.PoolClient,
  ): Promise<InventoryHoldEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      UPDATE inventory_holds
      SET status = $2
      WHERE id = $1
      RETURNING ${HOLD_PROJECTION};
    `;

    const result = await executor.query<InventoryHoldRow>(sql, [id, status]);
    const row = result.rows[0];
    return row ? mapRowToHoldEntity(row) : null;
  }

  /**
   * Atomic state transition primitive guarded by expected current status.
   * Prevents concurrency races between confirmation, expiration, and release.
   */
  async updateStatusGuarded(
    id: string,
    expectedCurrentStatus: InventoryHoldStatus,
    nextStatus: InventoryHoldStatus,
    client?: pg.PoolClient,
  ): Promise<InventoryHoldEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      UPDATE inventory_holds
      SET status = $3
      WHERE id = $1
        AND status = $2
      RETURNING ${HOLD_PROJECTION};
    `;

    const result = await executor.query<InventoryHoldRow>(sql, [
      id,
      expectedCurrentStatus,
      nextStatus,
    ]);
    const row = result.rows[0];
    return row ? mapRowToHoldEntity(row) : null;
  }

  /**
   * Release an active hold back to available inventory.
   */
  async releaseHold(id: string, client?: pg.PoolClient): Promise<boolean> {
    const executor = this.getExecutor(client);
    const sql = `
      UPDATE inventory_holds
      SET status = 'RELEASED'
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING id;
    `;

    const result = await executor.query(sql, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Find expired holds that remain marked as ACTIVE (for future worker cleanup).
   */
  async findExpiredActiveHolds(
    limit = 100,
    client?: pg.PoolClient,
  ): Promise<InventoryHoldEntity[]> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${HOLD_PROJECTION}
      FROM inventory_holds
      WHERE status = 'ACTIVE'
        AND expires_at <= NOW()
      ORDER BY expires_at ASC
      LIMIT $1;
    `;

    const result = await executor.query<InventoryHoldRow>(sql, [limit]);
    return result.rows.map(mapRowToHoldEntity);
  }
}
