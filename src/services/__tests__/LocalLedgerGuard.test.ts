import type * as SQLite from 'expo-sqlite';
import { LocalLedgerGuard } from '../LocalLedgerGuard';
import { CryptoSignatureEngine } from '../CryptoSignatureEngine';

// Mock the CryptoSignatureEngine to test LocalLedgerGuard logic independently
jest.mock('../CryptoSignatureEngine', () => ({
  CryptoSignatureEngine: {
    generateSignature: jest.fn(async (payload: string, secret: string) => {
      // Deterministic mock: create a simple hash-like string
      // In real code this uses Node crypto.createHmac
      const combined = payload + secret;
      let hash = 0;
      for (let i = 0; i < combined.length; i++) {
        const char = combined.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      const hexHash = Math.abs(hash).toString(16).padStart(8, '0').toUpperCase();
      return hexHash.slice(0, 8);
    }),
  },
}));

interface ChainRow {
  id: number;
  payload: string;
  previous_row_hash: string | null;
  row_signature: string;
}

function createMockDatabase(): {
  db: SQLite.SQLiteDatabase;
  store: ChainRow[];
} {
  const store: ChainRow[] = [];
  let nextId = 1;

  const db = {
    execAsync: jest.fn(async (sql: string) => {
      // No-op for schema creation
    }),

    runAsync: jest.fn(async (sql: string, params?: unknown[]) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      if (normalizedSql.includes('INSERT INTO')) {
        const typedParams = params as [string, string | null, string];
        const row: ChainRow = {
          id: nextId++,
          payload: typedParams[0],
          previous_row_hash: typedParams[1],
          row_signature: typedParams[2],
        };
        store.push(row);
      } else if (normalizedSql.includes('UPDATE')) {
        // Handle UPDATE ... SET ... WHERE id = ?
        const idMatch = normalizedSql.match(/WHERE ID = (\d+)/);
        if (idMatch) {
          const id = parseInt(idMatch[1], 10);
          const row = store.find((r) => r.id === id);
          if (row) {
            if (normalizedSql.includes('SET PAYLOAD')) {
              row.payload = (params as any[])[0] as string;
            } else if (normalizedSql.includes('SET PREVIOUS_ROW_HASH')) {
              row.previous_row_hash = (params as any[])[0] as string | null;
            } else if (normalizedSql.includes('SET ROW_SIGNATURE')) {
              row.row_signature = (params as any[])[0] as string;
            }
          }
        }
      } else if (normalizedSql.includes('DELETE FROM')) {
        // Clear table
        store.length = 0;
      }
    }),

    getFirstAsync: jest.fn(async (sql: string, _params?: unknown[]) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim().toUpperCase();
      if (normalizedSql.includes('SELECT ROW_SIGNATURE')) {
        // Return the last row's signature
        const lastRow = store[store.length - 1];
        return lastRow ? { row_signature: lastRow.row_signature } : null;
      }
      return null;
    }),

    getAllAsync: jest.fn(async (sql: string, _params?: unknown[]) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim().toUpperCase();
      if (normalizedSql.includes('SELECT')) {
        // Return all rows in order
        return store.map((row) => ({
          id: row.id,
          payload: row.payload,
          previous_row_hash: row.previous_row_hash,
          row_signature: row.row_signature,
        }));
      }
      return [];
    }),

    closeAsync: jest.fn(async () => {}),
  } as any as SQLite.SQLiteDatabase;

  return { db, store };
}

// Mock SQLite database for testing
let mockDb: SQLite.SQLiteDatabase;

describe('LocalLedgerGuard - Cryptographic Ledger Chain', () => {
  const DEVICE_SECRET = 'device_test_secret_key_12345';
  const TEST_TABLE = 'test_audit_chain';

  // ===========================================================================
  // Test Suite 1: Sequential Chain Generation
  // ===========================================================================

  describe('Sequential Chain Generation', () => {
    it('should generate a valid sequential chain with multiple entries', async () => {
      const { db, store } = createMockDatabase();
      const payloads = ['payload_1', 'payload_2', 'payload_3'];

      let previousHash = 'GENESIS_BLOCK_ANCHOR_00000000';

      // Build chain entry by entry
      for (const payload of payloads) {
        const newSig = await LocalLedgerGuard.computeChainHash(
          payload,
          previousHash,
          DEVICE_SECRET
        );

        await db.runAsync(
          `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
           VALUES (?, ?, ?)`,
          [payload, previousHash, newSig]
        );

        previousHash = newSig;
      }

      // Verify chain integrity - getAllAsync will return current store state
      const isValid = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        DEVICE_SECRET
      );
      expect(isValid).toBe(true);
    });

    it('should correctly compute deterministic signatures for the same payload', async () => {
      const payload = 'test_payload_data';
      const previousHash = 'TEST_PREVIOUS_HASH_ABC123';

      const sig1 = await LocalLedgerGuard.computeChainHash(
        payload,
        previousHash,
        DEVICE_SECRET
      );

      const sig2 = await LocalLedgerGuard.computeChainHash(
        payload,
        previousHash,
        DEVICE_SECRET
      );

      // Signatures should be identical for same inputs
      expect(sig1).toEqual(sig2);
      // Should be 8 uppercase hex characters
      expect(sig1).toMatch(/^[A-F0-9]{8}$/);
    });

    it('should generate different signatures for different payloads', async () => {
      const previousHash = 'SHARED_PREVIOUS_HASH_XYZ789';

      const sig1 = await LocalLedgerGuard.computeChainHash(
        'payload_A',
        previousHash,
        DEVICE_SECRET
      );

      const sig2 = await LocalLedgerGuard.computeChainHash(
        'payload_B',
        previousHash,
        DEVICE_SECRET
      );

      expect(sig1).not.toEqual(sig2);
    });

    it('should generate different signatures when previousHash changes', async () => {
      const payload = 'same_payload';

      const sig1 = await LocalLedgerGuard.computeChainHash(
        payload,
        'PREVIOUS_HASH_1',
        DEVICE_SECRET
      );

      const sig2 = await LocalLedgerGuard.computeChainHash(
        payload,
        'PREVIOUS_HASH_2',
        DEVICE_SECRET
      );

      expect(sig1).not.toEqual(sig2);
    });
  });

  // ===========================================================================
  // Test Suite 2: Tampering Detection
  // ===========================================================================

  describe('Tampering Detection', () => {
    it('should detect when a single row payload is modified retroactively', async () => {
      const { db } = createMockDatabase();

      // Build a valid chain
      let previousHash = 'GENESIS_BLOCK_ANCHOR_00000000';
      const originalPayload = 'original_payload';
      const sig1 = await LocalLedgerGuard.computeChainHash(
        originalPayload,
        previousHash,
        DEVICE_SECRET
      );

      await db.runAsync(
        `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
         VALUES (?, ?, ?)`,
        [originalPayload, previousHash, sig1]
      );

      previousHash = sig1;

      // Add second row
      const sig2 = await LocalLedgerGuard.computeChainHash(
        'second_payload',
        previousHash,
        DEVICE_SECRET
      );

      await db.runAsync(
        `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
         VALUES (?, ?, ?)`,
        ['second_payload', previousHash, sig2]
      );

      // Now tamper with the first row's payload
      await db.runAsync(`UPDATE ${TEST_TABLE} SET payload = ? WHERE id = 1`, [
        'tampered_payload',
      ]);

      // Verification should fail
      const isValid = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        DEVICE_SECRET
      );
      expect(isValid).toBe(false);
    });

    it('should detect when a row signature is corrupted', async () => {
      const { db } = createMockDatabase();

      // Build valid chain
      let previousHash = 'GENESIS_BLOCK_ANCHOR_00000000';

      const sig1 = await LocalLedgerGuard.computeChainHash(
        'payload_1',
        previousHash,
        DEVICE_SECRET
      );

      await db.runAsync(
        `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
         VALUES (?, ?, ?)`,
        ['payload_1', previousHash, sig1]
      );

      // Corrupt the signature
      await db.runAsync(
        `UPDATE ${TEST_TABLE} SET row_signature = ? WHERE id = 1`,
        ['CORRUPTED_SIG']
      );

      // Verification should fail
      const isValid = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        DEVICE_SECRET
      );
      expect(isValid).toBe(false);
    });

    it('should detect when previous_row_hash pointer is broken mid-chain', async () => {
      const { db } = createMockDatabase();

      // Build valid chain with 3 rows
      let previousHash = 'GENESIS_BLOCK_ANCHOR_00000000';

      const sig1 = await LocalLedgerGuard.computeChainHash(
        'payload_1',
        previousHash,
        DEVICE_SECRET
      );
      await db.runAsync(
        `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
         VALUES (?, ?, ?)`,
        ['payload_1', previousHash, sig1]
      );

      previousHash = sig1;

      const sig2 = await LocalLedgerGuard.computeChainHash(
        'payload_2',
        previousHash,
        DEVICE_SECRET
      );
      await db.runAsync(
        `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
         VALUES (?, ?, ?)`,
        ['payload_2', previousHash, sig2]
      );

      previousHash = sig2;

      const sig3 = await LocalLedgerGuard.computeChainHash(
        'payload_3',
        previousHash,
        DEVICE_SECRET
      );
      await db.runAsync(
        `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
         VALUES (?, ?, ?)`,
        ['payload_3', previousHash, sig3]
      );

      // Break the link: change row 2's previous_row_hash pointer
      await db.runAsync(
        `UPDATE ${TEST_TABLE} SET previous_row_hash = ? WHERE id = 2`,
        ['BROKEN_POINTER']
      );

      // Verification should fail
      const isValid = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        DEVICE_SECRET
      );
      expect(isValid).toBe(false);
    });

    it('should detect ID gaps in the chain sequence', async () => {
      const { db, store } = createMockDatabase();

      let previousHash = 'GENESIS_BLOCK_ANCHOR_00000000';
      const payloads = ['payload_1', 'payload_2', 'payload_3'];

      for (const payload of payloads) {
        const sig = await LocalLedgerGuard.computeChainHash(
          payload,
          previousHash,
          DEVICE_SECRET
        );

        await db.runAsync(
          `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
           VALUES (?, ?, ?)`,
          [payload, previousHash, sig]
        );

        previousHash = sig;
      }

      // Simulate deletion of historical row id=2, leaving IDs [1, 3].
      store.splice(1, 1);

      const isValid = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        DEVICE_SECRET
      );
      expect(isValid).toBe(false);
    });
  });

  // ===========================================================================
  // Test Suite 3: Genesis Block Handling
  // ===========================================================================

  describe('Genesis Block Handling', () => {
    it('should accept empty table as valid (no rows to verify)', async () => {
      const { db } = createMockDatabase();

      const isValid = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        DEVICE_SECRET
      );
      expect(isValid).toBe(true);
    });

    it('should accept single genesis entry starting from GENESIS_BLOCK_ANCHOR', async () => {
      const { db } = createMockDatabase();

      const payload = 'first_entry';
      const sig = await LocalLedgerGuard.computeChainHash(
        payload,
        'GENESIS_BLOCK_ANCHOR_00000000',
        DEVICE_SECRET
      );

      await db.runAsync(
        `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
         VALUES (?, ?, ?)`,
        [payload, 'GENESIS_BLOCK_ANCHOR_00000000', sig]
      );

      const isValid = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        DEVICE_SECRET
      );
      expect(isValid).toBe(true);
    });

    it('should reject first entry with incorrect previous_row_hash', async () => {
      const { db } = createMockDatabase();

      const payload = 'first_entry';
      const sig = await LocalLedgerGuard.computeChainHash(
        payload,
        'GENESIS_BLOCK_ANCHOR_00000000',
        DEVICE_SECRET
      );

      // Insert with wrong genesis anchor
      await db.runAsync(
        `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
         VALUES (?, ?, ?)`,
        [payload, 'WRONG_GENESIS_ANCHOR', sig]
      );

      const isValid = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        DEVICE_SECRET
      );
      expect(isValid).toBe(false);
    });
  });

  // ===========================================================================
  // Test Suite 4: Last Row Signature Retrieval
  // ===========================================================================

  describe('Last Row Signature Retrieval', () => {
    it('should return GENESIS_BLOCK_ANCHOR for empty table', async () => {
      const { db } = createMockDatabase();

      const lastSig = await LocalLedgerGuard.getLastRowSignature(db, TEST_TABLE);
      expect(lastSig).toEqual('GENESIS_BLOCK_ANCHOR_00000000');
    });

    it('should return the actual signature of the last inserted row', async () => {
      const { db } = createMockDatabase();

      const payload = 'test_payload';
      const sig = await LocalLedgerGuard.computeChainHash(
        payload,
        'GENESIS_BLOCK_ANCHOR_00000000',
        DEVICE_SECRET
      );

      await db.runAsync(
        `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
         VALUES (?, ?, ?)`,
        [payload, 'GENESIS_BLOCK_ANCHOR_00000000', sig]
      );

      const lastSig = await LocalLedgerGuard.getLastRowSignature(db, TEST_TABLE);
      expect(lastSig).toEqual(sig);
    });

    it('should return the signature of the most recent row with multiple entries', async () => {
      const { db } = createMockDatabase();

      let previousHash = 'GENESIS_BLOCK_ANCHOR_00000000';
      const payloads = ['first', 'second', 'third'];
      let lastSig = '';

      for (const payload of payloads) {
        lastSig = await LocalLedgerGuard.computeChainHash(
          payload,
          previousHash,
          DEVICE_SECRET
        );

        await db.runAsync(
          `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
           VALUES (?, ?, ?)`,
          [payload, previousHash, lastSig]
        );

        previousHash = lastSig;
      }

      const retrievedLastSig = await LocalLedgerGuard.getLastRowSignature(
        db,
        TEST_TABLE
      );
      expect(retrievedLastSig).toEqual(lastSig);
    });
  });

  // ===========================================================================
  // Test Suite 5: Different Device Secrets Rejection
  // ===========================================================================

  describe('Different Device Secrets Rejection', () => {
    it('should fail verification if device secret differs from chain origin', async () => {
      const secret1 = 'device_secret_one';
      const secret2 = 'device_secret_two';
      const { db } = createMockDatabase();

      // Build chain with secret1
      let previousHash = 'GENESIS_BLOCK_ANCHOR_00000000';
      const sig = await LocalLedgerGuard.computeChainHash(
        'payload_1',
        previousHash,
        secret1
      );

      await db.runAsync(
        `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
         VALUES (?, ?, ?)`,
        ['payload_1', previousHash, sig]
      );

      // Try to verify with secret2
      const isValid = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        secret2
      );
      expect(isValid).toBe(false);
    });
  });

  // ===========================================================================
  // Test Suite 6: Real-World Scenario - Complete Trip Sync Sequence
  // ===========================================================================

  describe('Real-World Scenario - Complete Trip Sync Sequence', () => {
    it('should maintain chain integrity through a multi-action sync sequence', async () => {
      const { db } = createMockDatabase();

      const actions = [
        { type: 'TRIP_START', data: { trip_id: 'T123', driver_id: 'D001' } },
        { type: 'LOCATION_UPDATE', data: { lat: 10.5, lng: 20.3 } },
        { type: 'LOCATION_UPDATE', data: { lat: 10.6, lng: 20.4 } },
        {
          type: 'TRIP_COMPLETE',
          data: { distance_km: 5.2, fare_amount: 150 },
        },
      ];

      let previousHash = 'GENESIS_BLOCK_ANCHOR_00000000';

      for (const action of actions) {
        const payload = JSON.stringify(action);
        const sig = await LocalLedgerGuard.computeChainHash(
          payload,
          previousHash,
          DEVICE_SECRET
        );

        await db.runAsync(
          `INSERT INTO ${TEST_TABLE} (payload, previous_row_hash, row_signature) 
           VALUES (?, ?, ?)`,
          [payload, previousHash, sig]
        );

        previousHash = sig;
      }

      // Full chain should validate
      const isValid = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        DEVICE_SECRET
      );
      expect(isValid).toBe(true);

      // Simulating attacker modifying fare_amount in final action
      const tamperedAction = {
        type: 'TRIP_COMPLETE',
        data: { distance_km: 5.2, fare_amount: 5000 }, // Fraudulent amount
      };
      await db.runAsync(`UPDATE ${TEST_TABLE} SET payload = ? WHERE id = 4`, [
        JSON.stringify(tamperedAction),
      ]);

      // Chain should now be broken
      const isValidAfterTamper = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        TEST_TABLE,
        DEVICE_SECRET
      );
      expect(isValidAfterTamper).toBe(false);
    });
  });
});
