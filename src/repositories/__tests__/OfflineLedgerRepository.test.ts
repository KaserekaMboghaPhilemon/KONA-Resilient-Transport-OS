import type { Knex } from 'knex';
import { OfflineLedgerRepository } from '../OfflineLedgerRepository';

const ORDER_ID = '123e4567-e89b-42d3-a456-426614174001';
const DRIVER_ID = '123e4567-e89b-42d3-a456-426614174002';
const ESCROW_ID = '123e4567-e89b-42d3-a456-426614174003';
const SOURCE_ID = '123e4567-e89b-42d3-a456-426614174004';
const STORAGE_ID = '123e4567-e89b-42d3-a456-426614174005';
const CASHOUT_ID = '123e4567-e89b-42d3-a456-426614174006';
const TREASURY_ID = '123e4567-e89b-42d3-a456-426614174007';

function createTransaction(orderStatus: string = 'pending_payment', failEntries = false) {
  const entries: Array<{ ledger_account_id: string; entry_side: string; amount_minor: string }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const escrow = {
    escrow_id: ESCROW_ID,
    source_client_payment_account_id: SOURCE_ID,
    target_driver_storage_wallet_account_id: STORAGE_ID,
    locked_amount_minor: '10000',
    currency_code: 'USD',
    status: 'locked',
  };
  const order = {
    order_id: ORDER_ID,
    active_driver_id: DRIVER_ID,
    status: orderStatus,
    driver_share_bps: 8000,
    kona_commission_bps: 2000,
  };

  const trx = ((table: string) => {
    let conditions: Record<string, unknown> = {};
    const query: Record<string, jest.Mock> = {
      where: jest.fn((value: Record<string, unknown>) => {
        conditions = value;
        return query;
      }),
      forUpdate: jest.fn(() => query),
      first: jest.fn(async () => {
        if (table === 'ride_orders') return order;
        if (table === 'booking_escrows') return escrow;
        if (table === 'ledger_accounts') {
          if (conditions.ledger_account_id === SOURCE_ID) {
            return {
              ledger_account_id: SOURCE_ID,
              account_type: 'client_payment_node',
              currency_code: 'USD',
              driver_id: null,
              is_active: true,
              current_balance_minor: '20000',
            };
          }
          if (conditions.ledger_account_id === STORAGE_ID) {
            return {
              ledger_account_id: STORAGE_ID,
              account_type: 'driver_storage_wallet',
              currency_code: 'USD',
              driver_id: DRIVER_ID,
              is_active: true,
              current_balance_minor: '10000',
            };
          }
          if (conditions.account_type === 'driver_cashout') {
            return {
              ledger_account_id: CASHOUT_ID,
              account_type: 'driver_cashout',
              currency_code: 'USD',
              driver_id: DRIVER_ID,
              is_active: true,
              current_balance_minor: '0',
            };
          }
          if (conditions.account_type === 'platform_treasury') {
            return {
              ledger_account_id: TREASURY_ID,
              account_type: 'platform_treasury',
              currency_code: 'USD',
              driver_id: null,
              is_active: true,
              current_balance_minor: '0',
            };
          }
        }
        return undefined;
      }),
      update: jest.fn(async (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return 1;
      }),
      insert: jest.fn((values: unknown) => {
        if (table === 'ledger_entries') {
          if (failEntries) {
            throw new Error('ledger write failed');
          }
          entries.push(...(values as typeof entries));
          return Promise.resolve();
        }
        return {
          returning: jest.fn().mockResolvedValue([{ ledger_transaction_id: 'transaction-1' }]),
        };
      }),
    };
    return query;
  }) as unknown as Knex.Transaction;

  return { trx, entries, updates, order, escrow };
}

function expectBalanced(entries: Array<{ entry_side: string; amount_minor: string }>) {
  const debits = entries
    .filter((entry) => entry.entry_side === 'debit')
    .reduce((sum, entry) => sum + BigInt(entry.amount_minor), 0n);
  const credits = entries
    .filter((entry) => entry.entry_side === 'credit')
    .reduce((sum, entry) => sum + BigInt(entry.amount_minor), 0n);
  expect(debits).toBe(credits);
}

describe('OfflineLedgerRepository financial postings', () => {
  it('posts balanced client-to-escrow entries before locking a booking', async () => {
    const { trx, entries, updates } = createTransaction();

    await OfflineLedgerRepository.apply('BOOKING_LOCK', ORDER_ID, DRIVER_ID, {}, trx);

    expect(entries).toEqual([
      expect.objectContaining({
        ledger_account_id: SOURCE_ID,
        entry_side: 'debit',
        amount_minor: '10000',
      }),
      expect.objectContaining({
        ledger_account_id: STORAGE_ID,
        entry_side: 'credit',
        amount_minor: '10000',
      }),
    ]);
    expectBalanced(entries);
    expect(updates).toContainEqual(
      expect.objectContaining({ table: 'ride_orders', values: expect.objectContaining({ status: 'escrow_locked' }) }),
    );
  });

  it('posts exact driver and commission splits before settling escrow', async () => {
    const { trx, entries, updates } = createTransaction('in_trip');

    await OfflineLedgerRepository.apply('TRIP_SETTLEMENT', ORDER_ID, DRIVER_ID, {}, trx);

    expect(entries).toEqual([
      expect.objectContaining({
        ledger_account_id: STORAGE_ID,
        entry_side: 'debit',
        amount_minor: '10000',
      }),
      expect.objectContaining({
        ledger_account_id: CASHOUT_ID,
        entry_side: 'credit',
        amount_minor: '8000',
      }),
      expect.objectContaining({
        ledger_account_id: TREASURY_ID,
        entry_side: 'credit',
        amount_minor: '2000',
      }),
    ]);
    expectBalanced(entries);
    expect(updates).toContainEqual(
      expect.objectContaining({ table: 'booking_escrows', values: expect.objectContaining({ status: 'settled' }) }),
    );
  });

  it('posts balanced escrow-to-client entries before reversing a booking', async () => {
    const { trx, entries, updates } = createTransaction('assigned');

    await OfflineLedgerRepository.apply(
      'BOOKING_REVERSAL',
      ORDER_ID,
      DRIVER_ID,
      { reversal_reason: 'cancelled' },
      trx,
    );

    expect(entries).toEqual([
      expect.objectContaining({
        ledger_account_id: STORAGE_ID,
        entry_side: 'debit',
        amount_minor: '10000',
      }),
      expect.objectContaining({
        ledger_account_id: SOURCE_ID,
        entry_side: 'credit',
        amount_minor: '10000',
      }),
    ]);
    expectBalanced(entries);
    expect(updates).toContainEqual(
      expect.objectContaining({ table: 'booking_escrows', values: expect.objectContaining({ status: 'reversed' }) }),
    );
  });

  it('does not transition escrow when journal insertion fails', async () => {
    const { trx, updates } = createTransaction('in_trip', true);

    await expect(
      OfflineLedgerRepository.apply('TRIP_SETTLEMENT', ORDER_ID, DRIVER_ID, {}, trx),
    ).rejects.toThrow('ledger write failed');
    expect(updates).not.toContainEqual(
      expect.objectContaining({ table: 'booking_escrows' }),
    );
    expect(updates).not.toContainEqual(
      expect.objectContaining({ table: 'ride_orders', values: expect.objectContaining({ status: 'settled' }) }),
    );
  });
});
