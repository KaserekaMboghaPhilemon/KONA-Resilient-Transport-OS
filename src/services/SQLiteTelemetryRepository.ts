import * as SQLite from 'expo-sqlite';

export interface TelemetryPing {
  id?: number;
  tripId: string;
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  timestamp: number;
}

interface TelemetryBufferRow {
  id: number;
  trip_id: string;
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  timestamp: number;
}

export class SQLiteTelemetryRepository {
  private readonly db: SQLite.SQLiteDatabase;

  constructor(databaseInstance: SQLite.SQLiteDatabase) {
    this.db = databaseInstance;
  }

  /**
   * Initializes the dedicated high-write telemetry buffer table.
   */
  async initialize(): Promise<void> {
    await this.db.execAsync(`
      CREATE TABLE IF NOT EXISTS driver_telemetry_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        speed REAL,
        heading REAL,
        timestamp INTEGER NOT NULL,
        is_synced INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_trip_id
      ON driver_telemetry_buffer(trip_id);
    `);
  }

  /**
   * Appends a GPS ping entry to local disk.
   */
  async logPing(ping: TelemetryPing): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO driver_telemetry_buffer (trip_id, latitude, longitude, speed, heading, timestamp)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [
        ping.tripId,
        ping.latitude,
        ping.longitude,
        ping.speed,
        ping.heading,
        ping.timestamp,
      ],
    );
  }

  /**
   * Retrieves all unsynced telemetry rows for a trip in chronological order.
   */
  async getUnsyncedPings(tripId: string): Promise<TelemetryPing[]> {
    const rows = await this.db.getAllAsync<TelemetryBufferRow>(
      `SELECT id, trip_id, latitude, longitude, speed, heading, timestamp
       FROM driver_telemetry_buffer
       WHERE trip_id = ? AND is_synced = 0
       ORDER BY timestamp ASC;`,
      [tripId],
    );

    return rows.map((row) => ({
      id: row.id,
      tripId: row.trip_id,
      latitude: row.latitude,
      longitude: row.longitude,
      speed: row.speed,
      heading: row.heading,
      timestamp: row.timestamp,
    }));
  }

  /**
   * Deletes pings that were successfully packaged and synchronized.
   */
  async clearSyncedPings(ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(',');
    await this.db.runAsync(
      `DELETE FROM driver_telemetry_buffer WHERE id IN (${placeholders});`,
      ids,
    );
  }
}
