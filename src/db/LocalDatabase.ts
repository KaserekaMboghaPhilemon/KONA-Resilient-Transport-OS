/**
 * Sprint 2 - Edge-State SQLite Local Node Cache
 *
 * Embeds a WAL-journaled SQLite database on the React Native client tier.
 * Mirrors the escrow, ledger, and order-lifecycle structures from
 * SPRINT1_SCHEMA.sql into device-local storage so every transactional
 * state shift is captured during full network outages and replayed to
 * the KONA backend exactly once on reconnection.
 *
 * Peer dependencies:
 *   expo-sqlite  >= 14.0.0
 *   expo-crypto  >= 13.0.0
 *   lz-string    >= 1.5.0
 */

import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import LZString from 'lz-string';

// ---------------------------------------------------------------------------
// Domain Types
// ---------------------------------------------------------------------------

/**
 * Every value maps directly to a ledger_transaction_type or order lifecycle
 * event declared in SPRINT1_SCHEMA.sql. The sync service uses this type
 * to reconstruct the correct server-side operation from a queue row alone,
 * without needing any additional context beyond the payload.
 */
export type OfflineActionType =
  | 'booking_lock'
  | 'booking_reversal'
  | 'trip_settlement'
  | 'order_status_update'
  | 'driver_location_update'
  | 'dispatch_offer_response';

export type QueueSyncStatus = 'pending' | 'synced' | 'failed';

// ---------------------------------------------------------------------------
// Row Interfaces
// ---------------------------------------------------------------------------

export interface QueueEntry {
  id: number;
  idempotency_key: string;
  order_id: string;
  action_type: OfflineActionType;
  /** lz-string base64-compressed JSON blob of the operation payload. */
  payload_compressed: string;
  created_at: number;
  attempt_count: number;
  last_attempt_at: number | null;
  synced_at: number | null;
  sync_status: QueueSyncStatus;
}

/** QueueEntry with payload_compressed replaced by the fully decoded object. */
export interface DecompressedQueueEntry extends Omit<QueueEntry, 'payload_compressed'> {
  payload: Record<string, unknown>;
}

export interface QueueResult {
  idempotency_key: string;
  /** true when a new row was written; false when INSERT OR IGNORE suppressed a duplicate. */
  inserted: boolean;
}

// ---------------------------------------------------------------------------
// Module-Level Singleton
// ---------------------------------------------------------------------------

let _db: SQLite.SQLiteDatabase | null = null;
const DB_FILENAME = 'kona_local_cache.db';

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * Append-only queue that captures every transactional state shift while the
 * device has no network access. Once inserted, a row's immutable columns
 * (idempotency_key through created_at) are never written again; only the
 * sync bookkeeping columns (sync_status, attempt_count, last_attempt_at,
 * synced_at) change after initial insertion.
 */
const SQL_CREATE_OFFLINE_SYNC_QUEUE = `
  CREATE TABLE IF NOT EXISTS offline_sync_queue (
    id                  INTEGER  PRIMARY KEY AUTOINCREMENT,
    idempotency_key     TEXT     NOT NULL UNIQUE,
    order_id            TEXT     NOT NULL,
    action_type         TEXT     NOT NULL,
    payload_compressed  TEXT     NOT NULL,
    created_at          INTEGER  NOT NULL,
    attempt_count       INTEGER  NOT NULL DEFAULT 0,
    last_attempt_at     INTEGER  NULL,
    synced_at           INTEGER  NULL,
    sync_status         TEXT     NOT NULL DEFAULT 'pending',
    CHECK (sync_status IN ('pending', 'synced', 'failed'))
  )`.trim();

const SQL_CREATE_SYNC_INDEX = `
  CREATE INDEX IF NOT EXISTS ix_offline_sync_queue_status_created
    ON offline_sync_queue (sync_status, created_at ASC)`.trim();

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Opens the SQLite database, activates WAL journaling, enforces foreign keys,
 * and creates all required tables. Returns the cached connection on repeated
 * calls. Must be awaited once at application startup before any other function
 * in this module is invoked.
 */
export async function initDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (_db !== null) {
    return _db;
  }

  const db = await SQLite.openDatabaseAsync(DB_FILENAME);

  // WAL mode: concurrent readers never block writers and each commit avoids a
  // full fsync, reducing write latency on flash storage.
  await db.execAsync('PRAGMA journal_mode = WAL;');

  // Enforce declarative foreign-key constraints for this connection handle.
  await db.execAsync('PRAGMA foreign_keys = ON;');

  // Prevent unbounded WAL growth during sustained offline burst writes.
  // Auto-checkpoint triggers after every 100 pages (~400 KB of WAL data).
  await db.execAsync('PRAGMA wal_autocheckpoint = 100;');

  await db.execAsync(SQL_CREATE_OFFLINE_SYNC_QUEUE);
  await db.execAsync(SQL_CREATE_SYNC_INDEX);

  _db = db;
  return _db;
}

function requireDatabase(): SQLite.SQLiteDatabase {
  if (_db === null) {
    throw new Error(
      '[LocalDatabase] initDatabase() must be called before any database operation.',
    );
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Idempotency Key Derivation
// ---------------------------------------------------------------------------

/**
 * Produces a 64-character lowercase hex SHA-256 digest over a canonical string
 * built from orderId, actionType, and the payload with keys sorted alphabetically.
 *
 * Sorting payload keys before serialisation guarantees the digest is identical
 * for the same logical operation regardless of property insertion order in the
 * caller's payload object. This key is forwarded verbatim to the KONA backend
 * on sync so the server can reject duplicate executions at its own boundary.
 */
async function deriveIdempotencyKey(
  orderId: string,
  actionType: OfflineActionType,
  payload: Record<string, unknown>,
): Promise<string> {
  const sortedPayload = Object.keys(payload)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = payload[key];
      return acc;
    }, {});

  const canonical = `${orderId}:${actionType}:${JSON.stringify(sortedPayload)}`;
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical);
}

// ---------------------------------------------------------------------------
// Core Queue Operation
// ---------------------------------------------------------------------------

/**
 * Derives a stable idempotency key, compresses the payload with lz-string, and
 * appends the entry to the offline_sync_queue table.
 *
 * If a row with the same idempotency key already exists locally, the SQLite
 * INSERT OR IGNORE clause discards the operation without error, ensuring the
 * queue never holds two records for the same logical event. This prevents
 * double-execution records from reaching the KONA backend when the sync service
 * replays the queue after reconnection.
 *
 * @param orderId     UUID of the ride_order this action is associated with.
 * @param actionType  Lifecycle or ledger event type (mirrors SPRINT1_SCHEMA.sql enums).
 * @param payload     JSON-serialisable operation data to persist on-device.
 */
export async function queueOfflineTransaction(
  orderId: string,
  actionType: OfflineActionType,
  payload: Record<string, unknown>,
): Promise<QueueResult> {
  if (typeof orderId !== 'string' || orderId.trim().length === 0) {
    throw new TypeError(
      '[queueOfflineTransaction] orderId must be a non-empty string.',
    );
  }
  if (!actionType) {
    throw new TypeError(
      '[queueOfflineTransaction] actionType must be a valid OfflineActionType.',
    );
  }

  const db = requireDatabase();
  const idempotencyKey = await deriveIdempotencyKey(orderId, actionType, payload);

  // compressToBase64 produces ASCII-safe output suitable for TEXT column storage.
  // Typical KONA fare/ledger JSON payloads compress to 45-60% of original size.
  const payloadCompressed = LZString.compressToBase64(JSON.stringify(payload));

  const result = await db.runAsync(
    `INSERT OR IGNORE INTO offline_sync_queue
       (idempotency_key, order_id, action_type, payload_compressed, created_at, sync_status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    idempotencyKey,
    orderId,
    actionType,
    payloadCompressed,
    Date.now(),
  );

  return {
    idempotency_key: idempotencyKey,
    inserted: result.changes === 1,
  };
}

// ---------------------------------------------------------------------------
// Sync Service Helpers
// ---------------------------------------------------------------------------

/**
 * Returns up to `limit` pending queue entries ordered oldest-first (FIFO).
 * Called by the sync service when the device regains connectivity.
 */
export async function getPendingQueueEntries(limit = 50): Promise<QueueEntry[]> {
  const db = requireDatabase();
  return db.getAllAsync<QueueEntry>(
    `SELECT * FROM offline_sync_queue
     WHERE sync_status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?`,
    limit,
  );
}

/** Records a successful backend acknowledgement for a single queue entry. */
export async function markQueueEntryAsSynced(idempotencyKey: string): Promise<void> {
  const db = requireDatabase();
  await db.runAsync(
    `UPDATE offline_sync_queue
     SET sync_status = 'synced',
         synced_at   = ?
     WHERE idempotency_key = ?`,
    Date.now(),
    idempotencyKey,
  );
}

/** Increments the retry counter and records the timestamp of the most recent attempt. */
export async function incrementQueueEntryAttemptCount(idempotencyKey: string): Promise<void> {
  const db = requireDatabase();
  await db.runAsync(
    `UPDATE offline_sync_queue
     SET attempt_count   = attempt_count + 1,
         last_attempt_at = ?
     WHERE idempotency_key = ?`,
    Date.now(),
    idempotencyKey,
  );
}

/** Permanently marks an entry that has exceeded its retry ceiling as failed. */
export async function markQueueEntryAsFailed(idempotencyKey: string): Promise<void> {
  const db = requireDatabase();
  await db.runAsync(
    `UPDATE offline_sync_queue
     SET sync_status     = 'failed',
         last_attempt_at = ?
     WHERE idempotency_key = ?`,
    Date.now(),
    idempotencyKey,
  );
}

/**
 * Decompresses the lz-string base64 payload column back to its original
 * JSON structure and returns a fully typed DecompressedQueueEntry.
 */
export async function decompressQueueEntry(
  entry: QueueEntry,
): Promise<DecompressedQueueEntry> {
  const rawJson = LZString.decompressFromBase64(entry.payload_compressed);
  if (rawJson === null) {
    throw new Error(
      `[decompressQueueEntry] Decompression returned null for idempotency_key: ` +
        `${entry.idempotency_key}. The stored payload may be corrupt.`,
    );
  }
  const { payload_compressed: _dropped, ...rest } = entry;
  return { ...rest, payload: JSON.parse(rawJson) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Test Utility
// ---------------------------------------------------------------------------

/**
 * Closes the database connection and nullifies the module-level singleton so
 * Jest can reinitialise a clean database between test suites.
 * Must not be called from production application code.
 */
export async function _resetDatabaseForTesting(): Promise<void> {
  if (_db !== null) {
    await _db.closeAsync();
    _db = null;
  }
}
