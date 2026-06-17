import { knex } from '../database/knex';

export class TripRepository {
  public static async createTripRecord(
    payload: Record<string, unknown>,
  ): Promise<void> {
    await knex('trips').insert({
      order_id: payload.order_id,
      driver_id: payload.driver_id,
      origin:
        typeof payload.origin === 'object'
          ? JSON.stringify(payload.origin)
          : payload.origin,
      destination:
        typeof payload.destination === 'object'
          ? JSON.stringify(payload.destination)
          : payload.destination,
      status: 'ASSIGNED',
      created_at: new Date(),
    });
  }

  public static async updateTripStatus(
    tripId: string,
    status: string,
  ): Promise<void> {
    await knex('trips').where({ order_id: tripId }).update({
      status,
      updated_at: new Date(),
    });
  }

  public static async updateTripFare(
    tripId: string,
    amount: number,
  ): Promise<void> {
    await knex('trips').where({ order_id: tripId }).update({
      fare_amount: amount,
      updated_at: new Date(),
    });
  }

  public static async terminateTripLifecycle(
    tripId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await knex.transaction(async (trx) => {
      await trx('trips').where({ order_id: tripId }).update({
        status: 'COMPLETED',
        updated_at: new Date(),
      });

      await trx('driver_ledgers').insert({
        order_id: tripId,
        driver_id: payload.driver_id,
        amount: payload.final_fare,
        transaction_type: 'TRIP_SETTLEMENT',
        created_at: new Date(),
      });
    });
  }
}
