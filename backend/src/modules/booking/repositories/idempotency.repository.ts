import type pg from 'pg';
import { DatabaseService } from '../../../infrastructure/database/index.js';

// ============================================================
// 1. Entity & Row Interfaces
// ============================================================

export interface IdempotencyEntity {
  id: string;
  userId: string;
  endpointScope: string;
  idempotencyKey: string;
  requestHash: string;
  responseCode: number | null;
  responseBody: unknown | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface IdempotencyRow {
  id: string;
  user_id: string;
  endpoint_scope: string;
  idempotency_key: string;
  request_hash: string;
  response_code: number | null;
  response_body: unknown | null;
  created_at: Date | string;
  expires_at: Date | string;
}

export interface CreateIdempotencyData {
  id?: string;
  userId: string;
  endpointScope: string;
  idempotencyKey: string;
  requestHash: string;
  responseCode?: number | null;
  responseBody?: unknown | null;
  expiresAt?: Date | string;
}

// ============================================================
// 2. Explicit SQL Projections
// ============================================================

const IDEMPOTENCY_PROJECTION = `
  id,
  user_id,
  endpoint_scope,
  idempotency_key,
  request_hash,
  response_code,
  response_body,
  created_at,
  expires_at
`;

function parseJsonField<T>(field: T | string | null | undefined): T | null {
  if (field === null || field === undefined) return null;
  if (typeof field === 'string') {
    try {
      return JSON.parse(field) as T;
    } catch {
      return field as unknown as T;
    }
  }
  return field;
}

function mapRowToIdempotencyEntity(row: IdempotencyRow): IdempotencyEntity {
  return {
    id: row.id,
    userId: row.user_id,
    endpointScope: row.endpoint_scope,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    responseCode: row.response_code !== null ? Number(row.response_code) : null,
    responseBody: parseJsonField(row.response_body),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

// ============================================================
// 3. IdempotencyRepository Class
// ============================================================

export class IdempotencyRepository {
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
   * Finds an idempotency record by scoped compound key (user_id, endpoint_scope, idempotency_key).
   */
  async find(
    userId: string,
    endpointScope: string,
    idempotencyKey: string,
    client?: pg.PoolClient,
  ): Promise<IdempotencyEntity | null> {
    const executor = this.getExecutor(client);
    const sql = `
      SELECT ${IDEMPOTENCY_PROJECTION}
      FROM idempotency_keys
      WHERE user_id = $1
        AND endpoint_scope = $2
        AND idempotency_key = $3;
    `;

    const result = await executor.query<IdempotencyRow>(sql, [
      userId,
      endpointScope,
      idempotencyKey,
    ]);
    const row = result.rows[0];
    return row ? mapRowToIdempotencyEntity(row) : null;
  }

  /**
   * Persists an idempotency key record.
   */
  async create(data: CreateIdempotencyData, client?: pg.PoolClient): Promise<IdempotencyEntity> {
    const executor = this.getExecutor(client);
    const sql = `
      INSERT INTO idempotency_keys (
        user_id,
        endpoint_scope,
        idempotency_key,
        request_hash,
        response_code,
        response_body,
        expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        COALESCE($7, NOW() + INTERVAL '24 hours')
      )
      RETURNING ${IDEMPOTENCY_PROJECTION};
    `;

    const values = [
      data.userId,
      data.endpointScope,
      data.idempotencyKey,
      data.requestHash,
      data.responseCode ?? null,
      data.responseBody !== undefined && data.responseBody !== null
        ? JSON.stringify(data.responseBody)
        : null,
      data.expiresAt ?? null,
    ];

    const result = await executor.query<IdempotencyRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create idempotency record: no row returned');
    }
    return mapRowToIdempotencyEntity(row);
  }

  /**
   * Deletes expired idempotency records (where expires_at <= NOW()).
   */
  async deleteExpired(client?: pg.PoolClient): Promise<number> {
    const executor = this.getExecutor(client);
    const sql = `
      DELETE FROM idempotency_keys
      WHERE expires_at <= NOW();
    `;

    const result = await executor.query(sql);
    return result.rowCount ?? 0;
  }
}
