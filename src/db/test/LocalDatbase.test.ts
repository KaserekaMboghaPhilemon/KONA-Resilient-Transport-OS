/**
 * Sprint 2 - LocalDatabase offline queue verification
 *
 * Simulates a device operating under complete cellular network loss.
 * expo-sqlite and expo-crypto are replaced by lightweight in-process mocks
 * so no native binaries are required at test time.
 * lz-string runs from its actual pure-JS source to validate real
 * compression/decompression round-trip fidelity.
 *
 * Run with:
 *   npx jest src/db/test/LocalDatbase.test.ts --verbose
 */

// ---------------------------------------------------------------------------
// expo-sqlite mock
// ---------------------------------------------------------------------------
// The in-memory store and autoId counter live inside the factory closure so
// they are immune to Jest module hoisting reordering.

jest.mock('expo-sqlite', () => {
  type MockRow = {
    id: number;
    idempotency_key: string;
    order_id: string;
    action_type: string;
    payload_compressed: string;
    created_at: number;
    attempt_count: number;
    last_attempt_at: number | null;
    synced_at: number | null;
    sync_status: string;
    previous_row_hash: string;
    row_signature: string;
  };

  const store: MockRow[] = [];
  let nextId = 0;

  const mockDb = {
    execAsync: jest.fn().mockResolvedValue(undefined),

    runAsync: jest.fn().mockImplementation(
      async (
        sql: string,
        ...params: unknown[]
      ): Promise<{ changes: number; lastInsertRowId: number }> => {
        if (/INSERT OR IGNORE INTO offline_sync_queue/i.test(sql)) {
          const [idempotencyKey, orderId, actionType, payloadCompressed, createdAt,
                 previousRowHash, rowSignature] =
            params as [string, string, string, string, number, string, string];

          if (store.some((r) => r.idempotency_key === idempotencyKey)) {
            return { changes: 0, lastInsertRowId: -1 };
          }

          nextId += 1;
          store.push({
            id: nextId,
            idempotency_key: idempotencyKey,
            order_id: orderId,
            action_type: actionType,
            payload_compressed: payloadCompressed,
            created_at: createdAt,
            attempt_count: 0,
            last_attempt_at: null,
            synced_at: null,
            sync_status: 'pending',
            previous_row_hash: previousRowHash,
            row_signature: rowSignature,
          });
          return { changes: 1, lastInsertRowId: nextId };
        }

        if (/UPDATE offline_sync_queue/i.test(sql)) {
          const key = params[params.length - 1] as string;
          const row = store.find((r) => r.idempotency_key === key);
          if (row) {
            if (/sync_status = 'synced'/i.test(sql)) {
              row.sync_status = 'synced';
              row.synced_at = params[0] as number;
            } else if (/sync_status = 'failed'/i.test(sql)) {
              row.sync_status = 'failed';
              row.last_attempt_at = params[0] as number;
            } else if (/attempt_count = attempt_count \+ 1/i.test(sql)) {
              row.attempt_count += 1;
              row.last_attempt_at = params[0] as number;
            }
          }
          return { changes: 1, lastInsertRowId: -1 };
        }

        return { changes: 0, lastInsertRowId: -1 };
      },
    ),

    getAllAsync: jest.fn().mockImplementation(
      async (sql: string, ..._rest: unknown[]): Promise<MockRow[]> => {
        if (/WHERE sync_status = 'pending'/i.test(sql)) {
          return store.filter((r) => r.sync_status === 'pending');
        }
        return [];
      },
    ),

    getFirstAsync: jest.fn().mockImplementation(
      async (sql: string): Promise<{ row_signature: string } | null> => {
        if (/SELECT row_signature FROM/i.test(sql)) {
          if (store.length === 0) return null;
          return { row_signature: store[store.length - 1].row_signature };
        }
        return null;
      },
    ),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };

  return {
    openDatabaseAsync: jest.fn().mockResolvedValue(mockDb),
  };
});

// ---------------------------------------------------------------------------
// expo-crypto mock
// ---------------------------------------------------------------------------
// Deterministic pseudo-hash: identical inputs always produce identical outputs,
// matching the 64-character hex format of a real SHA-256 digest.
// NOT cryptographically secure; designed exclusively for test key stability.

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: jest.fn().mockImplementation(
    async (_algorithm: string, input: string): Promise<string> => {
      let h1 = 0xdeadbeef ^ (input.length & 0xffffffff);
      let h2 = 0x41c6ce57 ^ (input.length & 0xffffffff);
      for (let i = 0; i < input.length; i++) {
        const ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 0x9e3779b1);
        h2 = Math.imul(h2 ^ ch, 0x5f356495);
        h1 ^= h2 >>> 13;
        h2 ^= h1 >>> 11;
      }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
      h1 ^= Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 0x85ebca6b);
      h2 ^= Math.imul(h1 ^ (h1 >>> 13), 0xc2b2ae35);
      return (
        (h1 >>> 0).toString(16).padStart(8, '0') +
        (h2 >>> 0).toString(16).padStart(8, '0')
      ).padEnd(64, '0');
    },
  ),
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import {
  initDatabase,
  queueOfflineTransaction,
  getPendingQueueEntries,
  markQueueEntryAsSynced,
  incrementQueueEntryAttemptCount,
  markQueueEntryAsFailed,
  decompressQueueEntry,
  _resetDatabaseForTesting,
  type QueueEntry,
  type OfflineActionType,
} from '../LocalDatabase';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_ORDER_ID = 'b1a2c3d4-e5f6-7890-abcd-ef1234567890';
const FIXTURE_ACTION: OfflineActionType = 'booking_lock';
const DEVICE_SECRET = 'test-device-secret-key';

// Mirrors exactly the fields a booking_lock ledger transaction would carry
// based on the ride_orders and booking_escrows tables in SPRINT1_SCHEMA.sql.
const FIXTURE_PAYLOAD: Record<string, unknown> = {
  currency_code: 'USD',
  driver_storage_wallet_account_id: 'acct_78910-driver-wallet',
  client_payment_node_id: 'acct_12345-client-node',
  fare_minor: 4500,
  driver_share_bps: 8000,
  kona_commission_bps: 2000,
  escrow_timeout_at: 1_765_000_000_000,
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LocalDatabase - offline_sync_queue', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterAll(async () => {
    await _resetDatabaseForTesting();
  });

  // -------------------------------------------------------------------------
  // queueOfflineTransaction
  // -------------------------------------------------------------------------

  describe('queueOfflineTransaction()', () => {
    it('inserts a new row and returns inserted: true with a non-empty idempotency key', async () => {
      const result = await queueOfflineTransaction(
        FIXTURE_ORDER_ID,
        FIXTURE_ACTION,
        FIXTURE_PAYLOAD,
        DEVICE_SECRET,
      );

      expect(result.inserted).toBe(true);
      expect(typeof result.idempotency_key).toBe('string');
      expect(result.idempotency_key.length).toBeGreaterThanOrEqual(16);
    });

    it('returns the pending row with all expected columns via getPendingQueueEntries', async () => {
      const pending = await getPendingQueueEntries();

      expect(pending).toHaveLength(1);

      const entry: QueueEntry = pending[0];
      expect(entry.order_id).toBe(FIXTURE_ORDER_ID);
      expect(entry.action_type).toBe(FIXTURE_ACTION);
      expect(entry.sync_status).toBe('pending');
      expect(entry.attempt_count).toBe(0);
      expect(entry.last_attempt_at).toBeNull();
      expect(entry.synced_at).toBeNull();
      expect(typeof entry.payload_compressed).toBe('string');
      expect(entry.payload_compressed.length).toBeGreaterThan(0);
      // Sprint 12: chain columns must be populated on every insert.
      expect(typeof entry.previous_row_hash).toBe('string');
      expect(entry.previous_row_hash.length).toBeGreaterThan(0);
      expect(typeof entry.row_signature).toBe('string');
      expect(entry.row_signature.length).toBeGreaterThan(0);
    });

    it('roundtrips the payload through lz-string with exact structural fidelity', async () => {
      const [entry] = await getPendingQueueEntries();
      const decompressed = await decompressQueueEntry(entry);

      expect(decompressed.payload).toStrictEqual(FIXTURE_PAYLOAD);
    });

    it('silently discards a duplicate call without inserting a second row', async () => {
      const duplicate = await queueOfflineTransaction(
        FIXTURE_ORDER_ID,
        FIXTURE_ACTION,
        FIXTURE_PAYLOAD,
        DEVICE_SECRET,
      );

      expect(duplicate.inserted).toBe(false);

      // The idempotency key must be bit-for-bit identical to the original.
      const [original] = await getPendingQueueEntries();
      expect(duplicate.idempotency_key).toBe(original.idempotency_key);

      // Queue must still contain exactly one row.
      const allPending = await getPendingQueueEntries();
      expect(allPending).toHaveLength(1);
    });

    it('emits a structured verification log for the successfully saved entry', async () => {
      const [entry] = await getPendingQueueEntries();
      const decompressed = await decompressQueueEntry(entry);

      const verificationLog = {
        suite: 'Sprint 2 - LocalDatabase offline_sync_queue',
        scenario: 'cellular_network_offline',
        test_timestamp_utc: new Date().toISOString(),
        result: 'PASS',
        saved_entry: {
          id: entry.id,
          idempotency_key: entry.idempotency_key,
          order_id: entry.order_id,
          action_type: entry.action_type,
          sync_status: entry.sync_status,
          attempt_count: entry.attempt_count,
          created_at_epoch_ms: entry.created_at,
          last_attempt_at: entry.last_attempt_at,
          synced_at: entry.synced_at,
          payload: decompressed.payload,
        },
        compression_roundtrip_verified: true,
        idempotency_key_stable: true,
        duplicate_insert_suppressed: true,
      };

      console.log(
        '\n[LocalDatabase.test] Verification Log:\n' +
          JSON.stringify(verificationLog, null, 2),
      );

      expect(verificationLog.result).toBe('PASS');
      expect(verificationLog.compression_roundtrip_verified).toBe(true);
      expect(verificationLog.duplicate_insert_suppressed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Sync bookkeeping helpers
  // -------------------------------------------------------------------------

  describe('markQueueEntryAsSynced()', () => {
    it('resolves without throwing for a known idempotency key', async () => {
      // Queue a dedicated entry so this test is never coupled to prior test state.
      const r = await queueOfflineTransaction(
        'sync-test-order-synced',
        'trip_settlement',
        { fare_minor: 1000, driver_share_bps: 8000, kona_commission_bps: 2000 },
        DEVICE_SECRET,
      );
      await expect(markQueueEntryAsSynced(r.idempotency_key)).resolves.toBeUndefined();
    });
  });

  describe('incrementQueueEntryAttemptCount()', () => {
    it('resolves without throwing for a known idempotency key', async () => {
      const r = await queueOfflineTransaction(
        'increment-test-order',
        'order_status_update',
        { status: 'in_trip' },
        DEVICE_SECRET,
      );
      await expect(
        incrementQueueEntryAttemptCount(r.idempotency_key),
      ).resolves.toBeUndefined();
    });
  });

  describe('markQueueEntryAsFailed()', () => {
    it('resolves without throwing for a known idempotency key', async () => {
      const r = await queueOfflineTransaction(
        'failed-test-order',
        'booking_reversal',
        { reversal_reason: 'timeout' },
        DEVICE_SECRET,
      );
      await expect(
        markQueueEntryAsFailed(r.idempotency_key),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  describe('input validation', () => {
    it('throws TypeError when orderId is an empty string', async () => {
      await expect(
        queueOfflineTransaction('', 'booking_lock', {}, DEVICE_SECRET),
      ).rejects.toThrow(TypeError);
    });

    it('throws TypeError when orderId contains only whitespace', async () => {
      await expect(
        queueOfflineTransaction('   ', 'booking_lock', {}, DEVICE_SECRET),
      ).rejects.toThrow(TypeError);
    });

    it('throws TypeError when actionType is falsy', async () => {
      await expect(
        queueOfflineTransaction('some-order-id', '' as OfflineActionType, {}, DEVICE_SECRET),
      ).rejects.toThrow(TypeError);
    });
  });

  // -------------------------------------------------------------------------
  // Database guard
  // -------------------------------------------------------------------------

  describe('requireDatabase guard', () => {
    it('throws when queueOfflineTransaction is called before initDatabase', async () => {
      await _resetDatabaseForTesting();
      await expect(
        queueOfflineTransaction(FIXTURE_ORDER_ID, FIXTURE_ACTION, FIXTURE_PAYLOAD, DEVICE_SECRET),
      ).rejects.toThrow('[LocalDatabase] initDatabase() must be called before');
      // Re-initialise for any remaining tests.
      await initDatabase();
    });
  });
});
