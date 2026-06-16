import * as SQLite from 'expo-sqlite';

export interface SyncQueueRow {
  id: number;
  idempotency_key: string;
  action_type: string;
  payload: string;
  status: 'PENDING' | 'TRANSMITTING' | 'FAILED_BACKOFF';
  attempt_count: number;
  last_attempt_at: number | null;
}

export class SQLiteSyncRepository {
  private static db: SQLite.SQLiteDatabase | null = null;

  /**
   * Initializes or connects to the local KONA offline cache database file
   */
  public static async initialize(): Promise<SQLite.SQLiteDatabase> {
    if (this.db) return this.db;

    // Open database instance file asynchronously
    this.db = await SQLite.openDatabaseAsync('kona_offline_cache.db');

    // Establish the persistent sync pipeline schema layout
    await this.db.execAsync(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS pending_sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE NOT NULL,
        action_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_queue_status_attempts 
      ON pending_sync_queue (status, last_attempt_at);
    `);

    return this.db;
  }

  /**
   * Safe transaction entry insertion using structural constraints to block duplicates
   */
  public static async enqueue(entry: {
    idempotencyKey: string;
    actionType: string;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    const database = await this.initialize();
    const serializedPayload = JSON.stringify(entry.payload);

    try {
      await database.runAsync(
        `INSERT INTO pending_sync_queue (idempotency_key, action_type, payload) VALUES (?, ?, ?)`,
        [entry.idempotencyKey, entry.actionType, serializedPayload]
      );
      return true;
    } catch (error) {
      // Gracefully capture constraints violation if key already exists (already enqueued)
      console.warn(`[KONA SQLite] Idempotency block triggered for key: ${entry.idempotencyKey}`);
      return false;
    }
  }

  /**
   * Retrieves all available non-blocked items currently waiting for synchronization processing
   */
  public static async getActiveQueue(): Promise<SyncQueueRow[]> {
    const database = await this.initialize();
    return await database.getAllAsync<SyncQueueRow>(
      `SELECT * FROM pending_sync_queue WHERE status != 'TRANSMITTING' ORDER BY id ASC`
    );
  }

  /**
   * Updates state boundaries of records during transmission loops to prevent race conditions
   */
  public static async updateStatus(id: number, status: SyncQueueRow['status'], attemptIncrement = 0): Promise<void> {
    const database = await this.initialize();
    const now = Date.now();
    await database.runAsync(
      `UPDATE pending_sync_queue 
       SET status = ?, attempt_count = attempt_count + ?, last_attempt_at = ? 
       WHERE id = ?`,
      [status, attemptIncrement, now, id]
    );
  }

  /**
   * Removes an entry completely from the local disk database upon verified successful server receipt
   */
  public static async dequeue(id: number): Promise<void> {
    const database = await this.initialize();
    await database.runAsync(`DELETE FROM pending_sync_queue WHERE id = ?`, [id]);
  }
}