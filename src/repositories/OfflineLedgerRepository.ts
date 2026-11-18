import type { Knex } from 'knex';

export type OfflineLedgerActionType =
  | 'BOOKING_LOCK'
  | 'BOOKING_REVERSAL'
  | 'TRIP_SETTLEMENT'
  | 'ORDER_STATUS_UPDATE'
  | 'DRIVER_LOCATION_UPDATE'
  | 'DISPATCH_OFFER_RESPONSE';

const DRIVER_ORDER_STATUSES = new Set(['en_route_pickup', 'in_trip', 'completed']);

interface EscrowRow {
  escrow_id: string;
  source_client_payment_account_id: string;
  target_driver_storage_wallet_account_id: string;
  locked_amount_minor: string | number;
  currency_code: string;
  status: string;
}

interface LedgerAccountRow {
  ledger_account_id: string;
  account_type: string;
  currency_code: string;
  driver_id: string | null;
  is_active: boolean;
  current_balance_minor: string | number;
}

interface OrderRow {
  order_id: string;
  active_driver_id: string | null;
  status: string;
  driver_share_bps: number | string;
  kona_commission_bps: number | string;
}

export class OfflineLedgerRepository {
  public static async apply(
    actionType: OfflineLedgerActionType,
    orderId: string,
    driverId: string,
    payload: Record<string, unknown>,
    trx: Knex.Transaction,
  ): Promise<void> {
    const now = new Date();
    const order = await trx('ride_orders')
      .where({ order_id: orderId })
      .forUpdate()
      .first<OrderRow>();

    if (!order) {
      throw new Error(`[OfflineLedgerRepository] Unknown order: ${orderId}.`);
    }
    if (order.active_driver_id && order.active_driver_id !== driverId) {
      throw new Error('[OfflineLedgerRepository] Authenticated driver does not own this order.');
    }

    switch (actionType) {
      case 'BOOKING_LOCK': {
        if (!['pending_payment', 'escrow_locked'].includes(order.status)) {
          throw new Error(`[OfflineLedgerRepository] Cannot lock booking in status ${order.status}.`);
        }
        const escrow = await trx('booking_escrows')
          .where({ order_id: orderId })
          .forUpdate()
          .first<EscrowRow>();
        if (!escrow) {
          throw new Error(`[OfflineLedgerRepository] No escrow exists for order ${orderId}.`);
        }
        if (escrow.status !== 'locked') {
          throw new Error(`[OfflineLedgerRepository] Cannot lock escrow in status ${escrow.status}.`);
        }
        await this.postBookingLock(trx, order, escrow, now);
        await trx('ride_orders').where({ order_id: orderId }).update({
          status: 'escrow_locked',
          booking_confirmed_at: now,
          updated_at: now,
        });
        return;
      }

      case 'BOOKING_REVERSAL': {
        if (order.active_driver_id !== driverId) {
          throw new Error('[OfflineLedgerRepository] Authenticated driver is not assigned to this order.');
        }
        const reason =
          typeof payload.reversal_reason === 'string' ? payload.reversal_reason.trim() : '';
        if (!reason) {
          throw new TypeError('[OfflineLedgerRepository] BOOKING_REVERSAL requires reversal_reason.');
        }
        const escrow = await trx('booking_escrows')
          .where({ order_id: orderId, status: 'locked' })
          .forUpdate()
          .first<EscrowRow>();
        if (!escrow) {
          throw new Error(`[OfflineLedgerRepository] No locked escrow available to reverse for ${orderId}.`);
        }
        await this.postBookingReversal(trx, order, escrow, now);
        const changedEscrows = await trx('booking_escrows')
          .where({ order_id: orderId, status: 'locked' })
          .update({ status: 'reversed', reversal_reason: reason, reversed_at: now });
        this.requireSingleUpdate(changedEscrows, 'reverse escrow');
        await trx('ride_orders').where({ order_id: orderId }).update({
          status: 'reversed',
          cancelled_at: now,
          updated_at: now,
        });
        return;
      }

      case 'TRIP_SETTLEMENT': {
        if (order.active_driver_id !== driverId) {
          throw new Error('[OfflineLedgerRepository] Authenticated driver is not assigned to this order.');
        }
        const escrow = await trx('booking_escrows')
          .where({ order_id: orderId, status: 'locked' })
          .forUpdate()
          .first<EscrowRow>();
        if (!escrow) {
          throw new Error(`[OfflineLedgerRepository] No locked escrow available to settle for ${orderId}.`);
        }
        if (!['in_trip', 'completed'].includes(order.status)) {
          throw new Error(`[OfflineLedgerRepository] Cannot settle order in status ${order.status}.`);
        }
        await this.postTripSettlement(trx, order, escrow, now);
        const changedEscrows = await trx('booking_escrows')
          .where({ order_id: orderId, status: 'locked' })
          .update({
          status: 'settled',
          settled_at: now,
        });
        this.requireSingleUpdate(changedEscrows, 'settle escrow');
        const orderUpdates: Record<string, unknown> = {
          status: 'settled',
          settled_at: now,
          updated_at: now,
        };
        if (order.status !== 'completed') {
          orderUpdates.completed_at = now;
        }
        await trx('ride_orders').where({ order_id: orderId }).update(orderUpdates);
        return;
      }

      case 'ORDER_STATUS_UPDATE': {
        const status = typeof payload.status === 'string' ? payload.status : '';
        if (!DRIVER_ORDER_STATUSES.has(status)) {
          throw new TypeError(`[OfflineLedgerRepository] Unsupported order status: ${status || '(empty)'}.`);
        }
        if (order.active_driver_id !== driverId) {
          throw new Error('[OfflineLedgerRepository] Authenticated driver is not assigned to this order.');
        }
        await trx('ride_orders').where({ order_id: orderId }).update({
          status,
          updated_at: now,
          ...(status === 'in_trip' ? { trip_started_at: now } : {}),
          ...(status === 'completed' ? { completed_at: now } : {}),
        });
        return;
      }

      case 'DRIVER_LOCATION_UPDATE': {
        const h3Cell = typeof payload.h3_cell === 'string' ? payload.h3_cell.trim() : '';
        if (!h3Cell) {
          throw new TypeError('[OfflineLedgerRepository] DRIVER_LOCATION_UPDATE requires h3_cell.');
        }
        const changedRows = await trx('driver_states')
          .where({ driver_id: driverId })
          .update({ current_h3_cell: h3Cell, last_tracker_update_at: now, updated_at: now });
        if (changedRows !== 1) {
          throw new Error(`[OfflineLedgerRepository] No driver state exists for ${driverId}.`);
        }
        return;
      }

      case 'DISPATCH_OFFER_RESPONSE': {
        const accepted = payload.accepted;
        if (typeof accepted !== 'boolean') {
          throw new TypeError('[OfflineLedgerRepository] DISPATCH_OFFER_RESPONSE requires accepted.');
        }
        const bidAmount = payload.bid_amount_minor;
        if (bidAmount !== undefined && (!Number.isSafeInteger(bidAmount) || Number(bidAmount) <= 0)) {
          throw new TypeError('[OfflineLedgerRepository] bid_amount_minor must be a positive integer.');
        }
        const changedRows = await trx('dispatch_offers')
          .where({ order_id: orderId, driver_id: driverId, status: 'offered' })
          .update({
            status: bidAmount !== undefined ? 'bid_submitted' : accepted ? 'accepted' : 'rejected',
            bid_amount_minor: bidAmount ?? null,
            bid_submitted_at: bidAmount !== undefined ? now : null,
            accepted_at: bidAmount === undefined && accepted ? now : null,
            rejected_at: bidAmount === undefined && !accepted ? now : null,
          });
        if (changedRows !== 1) {
          throw new Error(`[OfflineLedgerRepository] No pending dispatch offer exists for ${orderId}.`);
        }
        if (bidAmount === undefined && accepted) {
          await trx('ride_orders').where({ order_id: orderId }).update({
            active_driver_id: driverId,
            status: 'assigned',
            assigned_at: now,
            updated_at: now,
          });
        }
      }
    }
  }

    private static async postBookingLock(
      trx: Knex.Transaction,
      order: OrderRow,
      escrow: EscrowRow,
      now: Date,
    ): Promise<void> {
      const accounts = await this.getEscrowAccounts(trx, escrow);
      this.validateAccount(accounts.source, 'client_payment_node', escrow.currency_code);
      this.validateAccount(accounts.target, 'driver_storage_wallet', escrow.currency_code);
      this.requireSufficientBalance(accounts.source, escrow.locked_amount_minor);
      if (order.active_driver_id && accounts.target.driver_id !== order.active_driver_id) {
        throw new Error('[OfflineLedgerRepository] Escrow wallet is not owned by the assigned driver.');
      }

      await this.postJournal(trx, order, escrow, 'booking_lock', [
        { ledger_account_id: accounts.source.ledger_account_id, entry_side: 'debit' },
        { ledger_account_id: accounts.target.ledger_account_id, entry_side: 'credit' },
      ], now);
    }

    private static async postBookingReversal(
      trx: Knex.Transaction,
      order: OrderRow,
      escrow: EscrowRow,
      now: Date,
    ): Promise<void> {
      const accounts = await this.getEscrowAccounts(trx, escrow);
      this.validateAccount(accounts.source, 'client_payment_node', escrow.currency_code);
      this.validateAccount(accounts.target, 'driver_storage_wallet', escrow.currency_code);
      this.requireSufficientBalance(accounts.target, escrow.locked_amount_minor);
      if (accounts.target.driver_id !== order.active_driver_id) {
        throw new Error('[OfflineLedgerRepository] Escrow wallet is not owned by the assigned driver.');
      }

      await this.postJournal(trx, order, escrow, 'booking_reversal', [
        { ledger_account_id: accounts.target.ledger_account_id, entry_side: 'debit' },
        { ledger_account_id: accounts.source.ledger_account_id, entry_side: 'credit' },
      ], now);
    }

    private static async postTripSettlement(
      trx: Knex.Transaction,
      order: OrderRow,
      escrow: EscrowRow,
      now: Date,
    ): Promise<void> {
      const accounts = await this.getEscrowAccounts(trx, escrow);
      this.validateAccount(accounts.target, 'driver_storage_wallet', escrow.currency_code);
      this.requireSufficientBalance(accounts.target, escrow.locked_amount_minor);
      if (accounts.target.driver_id !== order.active_driver_id) {
        throw new Error('[OfflineLedgerRepository] Escrow wallet is not owned by the assigned driver.');
      }

      const driverShareBps = BigInt(order.driver_share_bps);
      const commissionBps = BigInt(order.kona_commission_bps);
      if (
        driverShareBps <= 0n ||
        commissionBps <= 0n ||
        driverShareBps + commissionBps !== 10_000n
      ) {
        throw new Error('[OfflineLedgerRepository] Order split percentages are invalid.');
      }

      const amount = this.parsePositiveAmount(escrow.locked_amount_minor);
      const driverAmount = (amount * driverShareBps) / 10_000n;
      const commissionAmount = amount - driverAmount;
      if (driverAmount <= 0n || commissionAmount <= 0n) {
        throw new Error('[OfflineLedgerRepository] Escrow amount is too small for the configured split.');
      }

      const [driverCashout, platformTreasury] = await Promise.all([
        trx('ledger_accounts')
          .where({
            account_type: 'driver_cashout',
            driver_id: order.active_driver_id,
            currency_code: escrow.currency_code,
            is_active: true,
          })
          .forUpdate()
          .first<LedgerAccountRow>(),
        trx('ledger_accounts')
          .where({
            account_type: 'platform_treasury',
            currency_code: escrow.currency_code,
            is_active: true,
          })
          .forUpdate()
          .first<LedgerAccountRow>(),
      ]);
      if (!driverCashout || !platformTreasury) {
        throw new Error('[OfflineLedgerRepository] Settlement accounts are missing or inactive.');
      }
      this.validateAccount(driverCashout, 'driver_cashout', escrow.currency_code);
      this.validateAccount(platformTreasury, 'platform_treasury', escrow.currency_code);

      await this.postJournal(trx, order, escrow, 'trip_settlement', [
        {
          ledger_account_id: accounts.target.ledger_account_id,
          entry_side: 'debit',
          amount_minor: amount.toString(),
        },
        {
          ledger_account_id: driverCashout.ledger_account_id,
          entry_side: 'credit',
          amount_minor: driverAmount.toString(),
        },
        {
          ledger_account_id: platformTreasury.ledger_account_id,
          entry_side: 'credit',
          amount_minor: commissionAmount.toString(),
        },
      ], now);
    }

    private static async getEscrowAccounts(
      trx: Knex.Transaction,
      escrow: EscrowRow,
    ): Promise<{ source: LedgerAccountRow; target: LedgerAccountRow }> {
      const [source, target] = await Promise.all([
        trx('ledger_accounts')
          .where({ ledger_account_id: escrow.source_client_payment_account_id, is_active: true })
          .forUpdate()
          .first<LedgerAccountRow>(),
        trx('ledger_accounts')
          .where({ ledger_account_id: escrow.target_driver_storage_wallet_account_id, is_active: true })
          .forUpdate()
          .first<LedgerAccountRow>(),
      ]);
      if (!source || !target) {
        throw new Error('[OfflineLedgerRepository] Escrow accounts are missing or inactive.');
      }
      return { source, target };
    }

    private static validateAccount(
      account: LedgerAccountRow,
      accountType: string,
      currencyCode: string,
    ): void {
      if (
        !account.is_active ||
        account.account_type !== accountType ||
        account.currency_code !== currencyCode
      ) {
        throw new Error(
          `[OfflineLedgerRepository] Expected an active ${accountType} account in ${currencyCode}.`,
        );
      }
    }

    private static async postJournal(
      trx: Knex.Transaction,
      order: OrderRow,
      escrow: EscrowRow,
      transactionType: 'booking_lock' | 'booking_reversal' | 'trip_settlement',
      entries: Array<{
        ledger_account_id: string;
        entry_side: 'debit' | 'credit';
        amount_minor?: string;
      }>,
      now: Date,
    ): Promise<void> {
      const amount = this.parsePositiveAmount(escrow.locked_amount_minor);
      const [transaction] = await trx('ledger_transactions')
        .insert({
          order_id: order.order_id,
          escrow_id: escrow.escrow_id,
          transaction_type: transactionType,
          status: 'posted',
          currency_code: escrow.currency_code,
          external_reference: `${transactionType}:${escrow.escrow_id}`,
          description: `${transactionType} for order ${order.order_id}`,
          posted_at: now,
        })
        .returning('ledger_transaction_id');
      const transactionId = transaction?.ledger_transaction_id;
      if (typeof transactionId !== 'string' || !transactionId) {
        throw new Error('[OfflineLedgerRepository] Database did not return a ledger transaction id.');
      }

      await trx('ledger_entries').insert(
        entries.map((entry) => ({
          ledger_transaction_id: transactionId,
          ledger_account_id: entry.ledger_account_id,
          entry_side: entry.entry_side,
          amount_minor: entry.amount_minor ?? amount.toString(),
        })),
      );
    }

    private static parsePositiveAmount(value: string | number): bigint {
      if (!/^\d+$/.test(String(value))) {
        throw new TypeError('[OfflineLedgerRepository] Escrow amount must be a positive integer.');
      }
      const amount = BigInt(value);
      if (amount <= 0n) {
        throw new TypeError('[OfflineLedgerRepository] Escrow amount must be a positive integer.');
      }
      return amount;
    }

    private static requireSufficientBalance(
      account: LedgerAccountRow,
      requiredAmount: string | number,
    ): void {
      if (!/^\d+$/.test(String(account.current_balance_minor))) {
        throw new Error('[OfflineLedgerRepository] Ledger account balance is invalid.');
      }
      if (BigInt(account.current_balance_minor) < this.parsePositiveAmount(requiredAmount)) {
        throw new Error('[OfflineLedgerRepository] Ledger account has insufficient funds.');
      }
    }

    private static requireSingleUpdate(changedRows: number, operation: string): void {
      if (changedRows !== 1) {
        throw new Error(`[OfflineLedgerRepository] Could not ${operation}; escrow state changed concurrently.`);
      }
    }
}
