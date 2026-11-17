import type { Knex } from 'knex';

export type OfflineLedgerActionType =
  | 'BOOKING_LOCK'
  | 'BOOKING_REVERSAL'
  | 'TRIP_SETTLEMENT'
  | 'ORDER_STATUS_UPDATE'
  | 'DRIVER_LOCATION_UPDATE'
  | 'DISPATCH_OFFER_RESPONSE';

const DRIVER_ORDER_STATUSES = new Set(['en_route_pickup', 'in_trip', 'completed']);

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
      .first<{ order_id: string; active_driver_id: string | null; status: string }>();

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
          .first<{ status: string }>();
        if (!escrow) {
          throw new Error(`[OfflineLedgerRepository] No escrow exists for order ${orderId}.`);
        }
        if (escrow.status !== 'locked') {
          throw new Error(`[OfflineLedgerRepository] Cannot lock escrow in status ${escrow.status}.`);
        }
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
        const changedEscrows = await trx('booking_escrows')
          .where({ order_id: orderId, status: 'locked' })
          .update({ status: 'reversed', reversal_reason: reason, reversed_at: now });
        if (changedEscrows !== 1) {
          throw new Error(`[OfflineLedgerRepository] No locked escrow available to reverse for ${orderId}.`);
        }
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
          .first<{ status: string }>();
        if (!escrow) {
          throw new Error(`[OfflineLedgerRepository] No locked escrow available to settle for ${orderId}.`);
        }
        if (!['in_trip', 'completed'].includes(order.status)) {
          throw new Error(`[OfflineLedgerRepository] Cannot settle order in status ${order.status}.`);
        }
        await trx('booking_escrows').where({ order_id: orderId }).update({
          status: 'settled',
          settled_at: now,
        });
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
}
