import { CryptoSignatureEngine } from './CryptoSignatureEngine';
import * as SQLite from 'expo-sqlite';

export interface AuditChainEntry {
  id: number;
  payload: string;
  previous_row_hash: string;
  row_signature: string;
}

export class LocalLedgerGuard {
  /**
   * Fetches the signature of the absolute last entry inserted into the queue table.
   * This forms the link anchor ($H_{n-1}$) for our new block.
   */
  public static async getLastRowSignature(db: SQLite.SQLiteDatabase, tableName: string): Promise<string> {
    const row = await db.getFirstAsync<{ row_signature: string }>(
      `SELECT row_signature FROM ${tableName} ORDER BY id DESC LIMIT 1;`
    );
    return row?.row_signature ?? 'GENESIS_BLOCK_ANCHOR_00000000';
  }

  /**
   * Computes the linked block signature for an outbound entry payload.
   */
  public static async computeChainHash(
    payload: string,
    previousHash: string,
    deviceSecret: string
  ): Promise<string> {
    // Bind the payload structurally to the previous hash link
    const compoundBlock = `${payload}:${previousHash}`;
    const signature = await CryptoSignatureEngine.generateSignature(compoundBlock, deviceSecret);
    return signature.slice(0, 8).toUpperCase();
  }

  /**
   * Audits an entire local storage table end-to-end to verify chain continuity.
   * @returns true if the database log is uncompromised, false if a structural break is caught.
   */
  public static async verifyTableIntegrity(
    db: SQLite.SQLiteDatabase,
    tableName: string,
    deviceSecret: string
  ): Promise<boolean> {
    try {
      const rows = await db.getAllAsync<AuditChainEntry>(
        `SELECT id, COALESCE(payload, payload_compressed) AS payload, previous_row_hash, row_signature
         FROM ${tableName}
         ORDER BY id ASC;`
      );

      let expectedPreviousHash = 'GENESIS_BLOCK_ANCHOR_00000000';
      let expectedRowId = rows.length > 0 ? rows[0].id : 1;

      for (const row of rows) {
        if (row.id !== expectedRowId) {
          console.error(`[LedgerAudit] Missing or out-of-order row detected: expected ID ${expectedRowId}, got ${row.id}`);
          return false;
        }

        // 1. Verify previous hash pointer matches our running tracker
        if (row.previous_row_hash !== expectedPreviousHash) {
          console.error(`[LedgerAudit] Chain break caught at row ID ${row.id}: Expected prev hash pointer ${expectedPreviousHash}, got ${row.previous_row_hash}`);
          return false;
        }

        // 2. Re-calculate current row's block signature
        const computedSig = await this.computeChainHash(row.payload, expectedPreviousHash, deviceSecret);
        if (row.row_signature !== computedSig) {
          console.error(`[LedgerAudit] Tampering detected at row ID ${row.id}: Signature validation failed.`);
          return false;
        }

        // Advance tracker pointer to current row's validated seal
        expectedPreviousHash = row.row_signature;
        expectedRowId += 1;
      }

      return true; // Entire local chain is verified pure and untampered
    } catch (error) {
      console.error('[LedgerAudit] Audit run exploded mid-execution:', error);
      return false;
    }
  }
}