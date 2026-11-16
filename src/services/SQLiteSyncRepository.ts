import * as SQLite from 'expo-sqlite';
import {
  getPendingQueueEntries,
  initDatabase,
  queueOfflineTransaction,
  type OfflineActionType,
} from '../db/LocalDatabase';
import { CANONICAL_OUTBOX_TABLE, LocalLedgerGuard } from './LocalLedgerGuard';

export interface SyncQueueRow {
  id: number;
  idempotency_key: string;
  action_type: string;
  payload: string;
  status: 'PENDING' | 'TRANSMITTING' | 'FAILED_BACKOFF';
  attempt_count: number;
  last_attempt_at: number | null;
  previous_row_hash: string;
  row_signature: string;
}

export class SQLiteSyncRepository {
  /**
   * @deprecated Initializes the canonical LocalDatabase outbox for legacy callers.
   */
  public static async initialize(): Promise<SQLite.SQLiteDatabase> {
    return initDatabase();
  }

  /**
   * @deprecated Writes through LocalDatabase.queueOfflineTransaction().
   */
  public static async enqueue(
    entry: {
      orderId: string;
      actionType: OfflineActionType;
      payload: Record<string, unknown>;
    },
    deviceSecret: string,
  ): Promise<boolean> {
    await this.initialize();
    const result = await queueOfflineTransaction(
      entry.orderId,
      entry.actionType,
      entry.payload,
      deviceSecret,
    );
    return result.inserted;
  }

  /**
   * @deprecated Reads pending entries from the canonical outbox.
   */
  public static async getActiveQueue(): Promise<SyncQueueRow[]> {
    await this.initialize();
    const entries = await getPendingQueueEntries();
    return entries.map((entry) => ({
      ...entry,
      payload: entry.payload_compressed,
      status: 'PENDING' as const,
    }));
  }

  /**
   * @deprecated Updates bookkeeping in the canonical outbox.
   */
  public static async updateStatus(
    id: number,
    _status: SyncQueueRow['status'],
  ): Promise<void> {
    const database = await this.initialize();
    const now = Date.now();
    await database.runAsync(
      `UPDATE ${CANONICAL_OUTBOX_TABLE}
       SET last_attempt_at = ?
       WHERE id = ?`,
      [now, id],
    );
  }

  /**
   * @deprecated Retains the append-only outbox row and marks it synced.
   */
  public static async dequeue(id: number): Promise<void> {
    const database = await this.initialize();
    await database.runAsync(
      `UPDATE ${CANONICAL_OUTBOX_TABLE}
       SET sync_status = 'synced', synced_at = ?
       WHERE id = ? AND sync_status = 'pending'`,
      [Date.now(), id],
    );
  }

  /**
   * Audits the canonical outbox for cryptographic chain integrity.
   * Used to detect if the local database has been tampered with at rest.
   * 
   * @param deviceSecret The device's HMAC secret for chain verification
   * @returns true if the entire queue ledger is pristine and untampered, false otherwise
   */
  public static async verifyQueueIntegrity(deviceSecret: string): Promise<boolean> {
    const database = await this.initialize();
    return LocalLedgerGuard.verifyTableIntegrity(database, CANONICAL_OUTBOX_TABLE, deviceSecret);
  }
}