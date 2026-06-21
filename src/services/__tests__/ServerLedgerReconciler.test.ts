import crypto from 'crypto';
import {
  IncomingLedgerRow,
  ServerLedgerReconciler,
} from '../ServerLedgerReconciler';

const DEVICE_SECRET = 'SERVER_SIDE_TEST_DEVICE_SECRET';
const ADMIN_SECRET = 'SERVER_SIDE_TEST_ADMIN_SECRET';

function signBlock(payload: string, previousHash: string): string {
  return crypto
    .createHmac('sha256', DEVICE_SECRET)
    .update(`${payload}:${previousHash}`)
    .digest('hex')
    .substring(0, 8)
    .toUpperCase();
}

function buildChainRows(payloads: string[]): IncomingLedgerRow[] {
  let prev = 'GENESIS_BLOCK_ANCHOR_00000000';

  return payloads.map((payload, index) => {
    const sig = signBlock(payload, prev);
    const row: IncomingLedgerRow = {
      id: index + 1,
      payload,
      previous_row_hash: prev,
      row_signature: sig,
    };
    prev = sig;
    return row;
  });
}

describe('ServerLedgerReconciler', () => {
  it('accepts a valid incoming chain with no gaps and matching signatures', async () => {
    const rows = buildChainRows([
      JSON.stringify({ action_type: 'CREATE_TRIP', order_id: 'ord-1' }),
      JSON.stringify({ action_type: 'START_RIDE', order_id: 'ord-1' }),
      JSON.stringify({ action_type: 'END_RIDE', order_id: 'ord-1' }),
    ]);

    const result = await ServerLedgerReconciler.verifyIncomingChain(
      rows,
      null,
      DEVICE_SECRET,
    );

    expect(result).toEqual({ success: true });
  });

  it('rejects rows when an ID gap is detected', async () => {
    const rows = buildChainRows([
      JSON.stringify({ action_type: 'CREATE_TRIP', order_id: 'ord-gap' }),
      JSON.stringify({ action_type: 'START_RIDE', order_id: 'ord-gap' }),
    ]);
    rows[1].id = 3;

    const result = await ServerLedgerReconciler.verifyIncomingChain(
      rows,
      null,
      DEVICE_SECRET,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('GAP_DETECTED');
    expect(result.failedRowId).toBe(3);
  });

  it('rejects tampered payload signatures', async () => {
    const rows = buildChainRows([
      JSON.stringify({ action_type: 'CREATE_TRIP', order_id: 'ord-tamper' }),
    ]);
    rows[0].payload = JSON.stringify({ action_type: 'CREATE_TRIP', order_id: 'ord-mutated' });

    const result = await ServerLedgerReconciler.verifyIncomingChain(
      rows,
      null,
      DEVICE_SECRET,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_SIGNATURE');
    expect(result.failedRowId).toBe(1);
  });

  it('rejects chain pointer mismatch as genesis mismatch breach', async () => {
    const rows = buildChainRows([
      JSON.stringify({ action_type: 'CREATE_TRIP', order_id: 'ord-pointer' }),
    ]);
    rows[0].previous_row_hash = 'BROKEN_PREVIOUS_POINTER';

    const result = await ServerLedgerReconciler.verifyIncomingChain(
      rows,
      null,
      DEVICE_SECRET,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('GENESIS_MISMATCH');
    expect(result.failedRowId).toBe(1);
  });

  it('verifies admin signature and emits deterministic sweep token', () => {
    const deviceId = 'device-001';
    const nonce = 112233;
    const authSignature = crypto
      .createHmac('sha256', ADMIN_SECRET)
      .update(`AUTH_CLEAR_LOCK:${deviceId}:${nonce}`)
      .digest('hex');

    const signatureOk = ServerLedgerReconciler.verifyAdminSweepSignature(
      ADMIN_SECRET,
      deviceId,
      nonce,
      authSignature,
    );
    expect(signatureOk).toBe(true);

    const tokenA = ServerLedgerReconciler.generateAdminSweepToken(
      ADMIN_SECRET,
      deviceId,
      nonce,
    );
    const tokenB = ServerLedgerReconciler.generateAdminSweepToken(
      ADMIN_SECRET,
      deviceId,
      nonce,
    );

    expect(tokenA).toBe(tokenB);
    expect(tokenA).toMatch(/^[a-f0-9]{64}$/);
  });
});
