import * as SQLite from 'expo-sqlite';
import {
  initDatabase,
  queueOfflineTransaction,
  _resetDatabaseForTesting,
} from '../../src/db/LocalDatabase';
import {
  SyncManager,
  type HttpsTransportAdapter,
} from '../../src/services/SyncManager';

type FieldQueueRow = {
  id: number;
  idempotency_key: string;
  order_id: string;
  action_type: string;
  payload_compressed: string;
  created_at: number;
  attempt_count: number;
  last_attempt_at: number | null;
  next_attempt_at: number | null;
  awaiting_server_ack: number;
  synced_at: number | null;
  sync_status: 'pending' | 'synced' | 'failed';
  previous_row_hash: string;
  row_signature: string;
};

jest.mock('expo-sqlite', () => {
  const rows: FieldQueueRow[] = [];
  let nextId = 0;
  const database = {
    execAsync: jest.fn().mockResolvedValue(undefined),
    closeAsync: jest.fn().mockResolvedValue(undefined),
    getAllAsync: jest.fn(
      async (sql: string, ...params: unknown[]): Promise<unknown[]> => {
        if (/PRAGMA table_info/i.test(sql)) {
          return [{ name: 'next_attempt_at' }, { name: 'awaiting_server_ack' }];
        }
        if (/SELECT current\.\*/i.test(sql)) {
          const now = params[0] as number;
          const limit = params[1] as number;
          return rows
            .filter(
              (row) =>
                row.sync_status === 'pending' &&
                (row.next_attempt_at === null || row.next_attempt_at <= now) &&
                !rows.some(
                  (earlier) =>
                    earlier.order_id === row.order_id &&
                    earlier.id < row.id &&
                    earlier.sync_status === 'pending',
                ),
            )
            .sort((left, right) => left.created_at - right.created_at || left.id - right.id)
            .slice(0, limit);
        }
        return [];
      },
    ),
    getFirstAsync: jest.fn(async (sql: string) => {
      if (/SELECT row_signature FROM/i.test(sql)) {
        return rows.length === 0 ? null : { row_signature: rows[rows.length - 1].row_signature };
      }
      return null;
    }),
    runAsync: jest.fn(
      async (
        sql: string,
        ...params: unknown[]
      ): Promise<{ changes: number; lastInsertRowId: number }> => {
        if (/INSERT OR IGNORE INTO offline_sync_queue/i.test(sql)) {
          const [
            idempotencyKey,
            orderId,
            actionType,
            payloadCompressed,
            createdAt,
            previousRowHash,
            rowSignature,
          ] = params as [string, string, string, string, number, string, string];
          if (rows.some((row) => row.idempotency_key === idempotencyKey)) {
            return { changes: 0, lastInsertRowId: -1 };
          }
          nextId += 1;
          rows.push({
            id: nextId,
            idempotency_key: idempotencyKey,
            order_id: orderId,
            action_type: actionType,
            payload_compressed: payloadCompressed,
            created_at: createdAt,
            attempt_count: 0,
            last_attempt_at: null,
            next_attempt_at: null,
            awaiting_server_ack: 0,
            synced_at: null,
            sync_status: 'pending',
            previous_row_hash: previousRowHash,
            row_signature: rowSignature,
          });
          return { changes: 1, lastInsertRowId: nextId };
        }

        const key = params[params.length - 1] as string;
        const row = rows.find((candidate) => candidate.idempotency_key === key);
        if (!row) return { changes: 0, lastInsertRowId: -1 };

        if (/sync_status\s*=\s*'synced'/i.test(sql)) {
          row.sync_status = 'synced';
          row.synced_at = params[0] as number;
          row.next_attempt_at = null;
          row.awaiting_server_ack = 0;
        } else if (/attempt_count\s*=\s*attempt_count\s*\+\s*1/i.test(sql)) {
          row.attempt_count += 1;
          row.last_attempt_at = params[0] as number;
          row.next_attempt_at = params[1] as number | null;
          if (params[2] === 1) row.awaiting_server_ack = 1;
        } else if (/sync_status\s*=\s*'failed'/i.test(sql)) {
          row.sync_status = 'failed';
          row.last_attempt_at = params[0] as number;
          row.next_attempt_at = null;
          row.awaiting_server_ack = 0;
        }
        return { changes: 1, lastInsertRowId: -1 };
      },
    ),
  };

  return {
    openDatabaseAsync: jest.fn().mockResolvedValue(database),
    __mockDb: {
      rows,
      reset: () => {
        rows.splice(0, rows.length);
        nextId = 0;
      },
    },
  };
});

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: jest.fn().mockResolvedValue('field-network-idempotency-key'),
}));

jest.mock('../../src/services/LocalLedgerGuard', () => ({
  LocalLedgerGuard: {
    getLastRowSignature: jest.fn().mockResolvedValue('GENESIS_BLOCK_ANCHOR_00000000'),
    computeChainHash: jest.fn().mockResolvedValue('field-network-row-signature'),
  },
}));

jest.mock('../../src/services/SQLiteSyncRepository', () => ({
  SQLiteSyncRepository: {
    initialize: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue(true),
    getActiveQueue: jest.fn().mockResolvedValue([]),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    dequeue: jest.fn().mockResolvedValue(undefined),
  },
}));

type DropScenario = 'response-lost-after-commit' | 'timeout-before-delivery';

function createFieldNetworkAdapter(scenario: DropScenario): {
  adapter: HttpsTransportAdapter;
  attempts: string[];
  serverCommits: Map<string, Record<string, unknown>>;
} {
  const attempts: string[] = [];
  const serverCommits = new Map<string, Record<string, unknown>>();
  let injectDrop = true;

  return {
    attempts,
    serverCommits,
    adapter: {
      async post(request): Promise<boolean> {
        attempts.push(request.idempotency_key);

        if (injectDrop && scenario === 'timeout-before-delivery') {
          injectDrop = false;
          throw new Error('ETIMEDOUT: simulated Kakuma 2G/Edge upload timeout');
        }

        if (!serverCommits.has(request.idempotency_key)) {
          serverCommits.set(request.idempotency_key, request.payload);
        }

        if (injectDrop) {
          injectDrop = false;
          throw new Error('ECONNRESET: response lost after server committed booking_lock');
        }

        return true;
      },
    },
  };
}

function makeSyncManager(adapter: HttpsTransportAdapter): SyncManager {
  return new SyncManager({
    connectivityProbe: { getState: () => 'internet' },
    httpsAdapter: adapter,
    smsAdapter: { send: async () => false },
  });
}

function getPersistedRows(): FieldQueueRow[] {
  const mockDb = (SQLite as unknown as {
    __mockDb: { rows: FieldQueueRow[]; reset: () => void };
  }).__mockDb;
  return mockDb.rows;
}

function resetPersistedRows(): void {
  const mockDb = (SQLite as unknown as {
    __mockDb: { rows: FieldQueueRow[]; reset: () => void };
  }).__mockDb;
  mockDb.reset();
}

describe('Kakuma field-network recovery simulation', () => {
  beforeEach(async () => {
    await _resetDatabaseForTesting();
    resetPersistedRows();
    await initDatabase();
  });

  afterEach(async () => {
    await _resetDatabaseForTesting();
    resetPersistedRows();
  });

  it('replays a booking_lock after the server commits but its response is lost', async () => {
    const queued = await queueOfflineTransaction(
      'field-order-response-drop',
      'booking_lock',
      {
        currency_code: 'USD',
        fare_minor: 4500,
        driver_share_bps: 8000,
        kona_commission_bps: 2000,
      },
      'field-test-device-secret',
    );
    const network = createFieldNetworkAdapter('response-lost-after-commit');
    const initialManager = makeSyncManager(network.adapter);

    const firstReport = await initialManager.processOfflineQueue();
    expect(firstReport.retried).toBe(1);
    expect(getPersistedRows()[0]).toMatchObject({
      idempotency_key: queued.idempotency_key,
      sync_status: 'pending',
      attempt_count: 1,
      awaiting_server_ack: 0,
    });
    expect(network.serverCommits.size).toBe(1);

    await expect(initialManager.processOfflineQueue()).resolves.toMatchObject({
      total_entries_processed: 0,
    });
    expect(network.attempts).toHaveLength(1);

    await _resetDatabaseForTesting();
    await initDatabase();
    getPersistedRows()[0].next_attempt_at = Date.now() - 1;

    const recoveredManager = makeSyncManager(network.adapter);
    const recoveryReport = await recoveredManager.processOfflineQueue();

    expect(recoveryReport.synced_via_https).toBe(1);
    expect(network.attempts).toEqual([
      queued.idempotency_key,
      queued.idempotency_key,
    ]);
    expect(network.serverCommits.size).toBe(1);
    expect(getPersistedRows()[0]).toMatchObject({
      idempotency_key: queued.idempotency_key,
      sync_status: 'synced',
      awaiting_server_ack: 0,
    });
  });

  it('retains a timed-out 2G/Edge upload until backoff expires and redial succeeds', async () => {
    const queued = await queueOfflineTransaction(
      'field-order-2g-timeout',
      'booking_lock',
      {
        currency_code: 'USD',
        fare_minor: 3800,
        driver_share_bps: 8000,
        kona_commission_bps: 2000,
      },
      'field-test-device-secret',
    );
    const network = createFieldNetworkAdapter('timeout-before-delivery');
    const manager = makeSyncManager(network.adapter);

    const failedAttempt = await manager.processOfflineQueue();
    expect(failedAttempt.retried).toBe(1);
    expect(network.serverCommits.size).toBe(0);
    expect(getPersistedRows()[0]).toMatchObject({
      idempotency_key: queued.idempotency_key,
      sync_status: 'pending',
      attempt_count: 1,
    });
    expect(getPersistedRows()[0].next_attempt_at).toBeGreaterThan(Date.now());

    const beforeBackoff = await manager.processOfflineQueue();
    expect(beforeBackoff.total_entries_processed).toBe(0);
    expect(network.attempts).toHaveLength(1);

    getPersistedRows()[0].next_attempt_at = Date.now() - 1;
    const redial = await manager.processOfflineQueue();

    expect(redial.synced_via_https).toBe(1);
    expect(network.attempts).toEqual([
      queued.idempotency_key,
      queued.idempotency_key,
    ]);
    expect(network.serverCommits.size).toBe(1);
    expect(getPersistedRows()[0].sync_status).toBe('synced');
  });
});
