import type * as SQLite from 'expo-sqlite';

import {
  SQLiteTelemetryRepository,
  type TelemetryPing,
} from '../SQLiteTelemetryRepository';

type InternalTelemetryRow = {
  id: number;
  trip_id: string;
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  timestamp: number;
  is_synced: number;
};

function createMockDatabase(): {
  db: SQLite.SQLiteDatabase;
  store: InternalTelemetryRow[];
  getLastExecSql: () => string;
} {
  const store: InternalTelemetryRow[] = [];
  let nextId = 1;
  let lastExecSql = '';

  const db = {
    execAsync: jest.fn(async (sql: string) => {
      lastExecSql = sql;
    }),

    runAsync: jest.fn(async (sql: string, params?: unknown[]) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      if (normalizedSql.startsWith('INSERT INTO DRIVER_TELEMETRY_BUFFER')) {
        const typedParams = params as [
          string,
          number,
          number,
          number | null,
          number | null,
          number,
        ];

        const row: InternalTelemetryRow = {
          id: nextId++,
          trip_id: typedParams[0],
          latitude: typedParams[1],
          longitude: typedParams[2],
          speed: typedParams[3],
          heading: typedParams[4],
          timestamp: typedParams[5],
          is_synced: 0,
        };

        store.push(row);
        return;
      }

      if (normalizedSql.startsWith('DELETE FROM DRIVER_TELEMETRY_BUFFER WHERE ID IN')) {
        const ids = (params as number[]) ?? [];
        const idSet = new Set(ids);
        for (let i = store.length - 1; i >= 0; i--) {
          if (idSet.has(store[i]!.id)) {
            store.splice(i, 1);
          }
        }
      }
    }),

    getAllAsync: jest.fn(async (_sql: string, params?: unknown[]) => {
      const tripId = params?.[0] as string;
      return store
        .filter((row) => row.trip_id === tripId && row.is_synced === 0)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((row) => ({
          id: row.id,
          trip_id: row.trip_id,
          latitude: row.latitude,
          longitude: row.longitude,
          speed: row.speed,
          heading: row.heading,
          timestamp: row.timestamp,
        }));
    }),
  } as unknown as SQLite.SQLiteDatabase;

  return {
    db,
    store,
    getLastExecSql: () => lastExecSql,
  };
}

describe('SQLiteTelemetryRepository', () => {
  it('initialize creates telemetry table and trip_id index', async () => {
    const { db, getLastExecSql } = createMockDatabase();
    const repo = new SQLiteTelemetryRepository(db);

    await repo.initialize();

    const executedSql = getLastExecSql().toUpperCase();
    expect(executedSql).toContain('CREATE TABLE IF NOT EXISTS DRIVER_TELEMETRY_BUFFER');
    expect(executedSql).toContain('CREATE INDEX IF NOT EXISTS IDX_TELEMETRY_TRIP_ID');
  });

  it('logPing writes rows and getUnsyncedPings returns them ordered by timestamp asc', async () => {
    const { db } = createMockDatabase();
    const repo = new SQLiteTelemetryRepository(db);

    const outOfOrderPings: TelemetryPing[] = [
      {
        tripId: 'trip-001',
        latitude: -1.2833,
        longitude: 36.8167,
        speed: 9.5,
        heading: 120,
        timestamp: 1700000003000,
      },
      {
        tripId: 'trip-001',
        latitude: -1.2834,
        longitude: 36.8168,
        speed: 10.2,
        heading: 121,
        timestamp: 1700000001000,
      },
      {
        tripId: 'trip-001',
        latitude: -1.2835,
        longitude: 36.8169,
        speed: null,
        heading: null,
        timestamp: 1700000002000,
      },
    ];

    for (const ping of outOfOrderPings) {
      await repo.logPing(ping);
    }

    const result = await repo.getUnsyncedPings('trip-001');

    expect(result).toHaveLength(3);
    expect(result.map((row) => row.timestamp)).toEqual([
      1700000001000,
      1700000002000,
      1700000003000,
    ]);
    expect(result.every((row) => row.tripId === 'trip-001')).toBe(true);
  });

  it('clearSyncedPings deletes batch ids and keeps non-target rows', async () => {
    const { db, store } = createMockDatabase();
    const repo = new SQLiteTelemetryRepository(db);

    await repo.logPing({
      tripId: 'trip-002',
      latitude: -1.1,
      longitude: 36.1,
      speed: 1,
      heading: 10,
      timestamp: 1,
    });
    await repo.logPing({
      tripId: 'trip-002',
      latitude: -1.2,
      longitude: 36.2,
      speed: 2,
      heading: 20,
      timestamp: 2,
    });
    await repo.logPing({
      tripId: 'trip-002',
      latitude: -1.3,
      longitude: 36.3,
      speed: 3,
      heading: 30,
      timestamp: 3,
    });

    expect(store.map((row) => row.id)).toEqual([1, 2, 3]);

    await repo.clearSyncedPings([1, 3]);

    expect(store.map((row) => row.id)).toEqual([2]);

    const remaining = await repo.getUnsyncedPings('trip-002');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(2);
  });

  it('clearSyncedPings is a no-op when ids array is empty', async () => {
    const { db } = createMockDatabase();
    const repo = new SQLiteTelemetryRepository(db);

    await expect(repo.clearSyncedPings([])).resolves.toBeUndefined();
  });
});
