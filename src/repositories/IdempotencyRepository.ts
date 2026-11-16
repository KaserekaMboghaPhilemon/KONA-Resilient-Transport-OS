import { knex } from '../database/knex';
import type { Knex } from 'knex';

export class IdempotencyRepository {
  /**
   * Attempts to record an idempotency key in the caller's transaction.
   * @returns true if duplicate exists, false if this is a new key.
   */
  public static async checkAndRegisterKey(
    idempotencyKey: string,
    trx: Knex | Knex.Transaction = knex,
  ): Promise<boolean> {
    const insertedRows = await trx('processed_idempotency_keys')
      .insert({
        key: idempotencyKey,
        processed_at: new Date(),
      })
      .onConflict('key')
      .ignore()
      .returning('key');

    return insertedRows.length === 0;
  }

  /**
   * Removes an idempotency key when explicitly requested by a caller.
   */
  public static async releaseKey(
    idempotencyKey: string,
    trx: Knex | Knex.Transaction = knex,
  ): Promise<void> {
    await trx('processed_idempotency_keys').where({ key: idempotencyKey }).del();
  }
}
