import crypto from 'crypto';

const GENESIS_ANCHOR = 'GENESIS_BLOCK_ANCHOR_00000000';

export interface IncomingLedgerRow {
  id: number;
  payload: string;
  previous_row_hash: string;
  row_signature: string;
}

export type ReconciliationErrorCode =
  | 'GAP_DETECTED'
  | 'INVALID_SIGNATURE'
  | 'GENESIS_MISMATCH';

export interface ReconciliationResult {
  success: boolean;
  error?: ReconciliationErrorCode;
  failedRowId?: number;
}

export class ServerLedgerReconciler {
  /**
   * Validates an incoming batch of local ledger rows against the expected chain rules.
   */
  public static async verifyIncomingChain(
    rows: IncomingLedgerRow[],
    lastValidServerHash: string | null,
    deviceSecret: string,
  ): Promise<ReconciliationResult> {
    if (rows.length === 0) {
      return { success: true };
    }

    let expectedPreviousHash = lastValidServerHash || GENESIS_ANCHOR;

    const sortedRows = [...rows].sort((a, b) => a.id - b.id);
    let expectedRowId = sortedRows[0].id;

    for (const row of sortedRows) {
      if (row.id !== expectedRowId) {
        return { success: false, error: 'GAP_DETECTED', failedRowId: row.id };
      }

      if (row.previous_row_hash !== expectedPreviousHash) {
        return { success: false, error: 'GENESIS_MISMATCH', failedRowId: row.id };
      }

      const compoundBlock = `${row.payload}:${expectedPreviousHash}`;
      const computedSig = crypto
        .createHmac('sha256', deviceSecret)
        .update(compoundBlock)
        .digest('hex')
        .substring(0, 8)
        .toUpperCase();

      if (row.row_signature !== computedSig) {
        return { success: false, error: 'INVALID_SIGNATURE', failedRowId: row.id };
      }

      expectedPreviousHash = row.row_signature;
      expectedRowId++;
    }

    return { success: true };
  }

  public static verifyBatchSignature(
    rows: IncomingLedgerRow[],
    providedSignatureHex: string,
    deviceSecret: string,
    deviceId: string,
  ): boolean {
    const canonical = `${deviceId}:${rows
      .map((row) => `${row.id}:${row.row_signature}`)
      .join('|')}`;
    const computed = crypto
      .createHmac('sha256', deviceSecret)
      .update(canonical)
      .digest('hex')
      .toUpperCase();

    return this.timingSafeEqualHex(computed, providedSignatureHex.toUpperCase());
  }

  /**
   * Generates an administrative sweep payload capable of resetting a locked device status.
   */
  public static generateAdminSweepToken(
    adminSecret: string,
    deviceId: string,
    nonce: number,
  ): string {
    const payload = `SWEEP:${deviceId}:${nonce}`;
    return crypto
      .createHmac('sha256', adminSecret)
      .update(payload)
      .digest('hex');
  }

  public static verifyAdminSweepSignature(
    adminSecret: string,
    deviceId: string,
    nonce: number,
    providedSignatureHex: string,
  ): boolean {
    const payload = `AUTH_CLEAR_LOCK:${deviceId}:${nonce}`;
    const expected = crypto
      .createHmac('sha256', adminSecret)
      .update(payload)
      .digest('hex')
      .toUpperCase();

    return this.timingSafeEqualHex(expected, providedSignatureHex.toUpperCase());
  }

  private static timingSafeEqualHex(left: string, right: string): boolean {
    if (left.length !== right.length) {
      return false;
    }

    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }
}
