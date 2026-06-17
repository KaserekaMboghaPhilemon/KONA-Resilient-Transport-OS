import { knex } from '../database/knex';

export class IdempotencyRepository {
  /**
   * Attempts to record an idempotency key.
   * Uses PostgreSQL unique constraint violation code 23505 to detect duplicates.
   * @returns true if duplicate exists, false if this is a new key.
   */
  public static async checkAndRegisterKey(
    idempotencyKey: string,
  ): Promise<boolean> {
    try {
      await knex('processed_idempotency_keys').insert({
        key: idempotencyKey,
        processed_at: new Date(),
      });
      return false;
    } catch (error: unknown) {
      const dbError = error as { code?: string };
      if (dbError.code === '23505') {
        return true;
      }
      throw error;
    }
  }

  /**
   * Removes an idempotency key when a transaction fails mid-flight,
   * allowing safe retries from edge devices.
   */
  public static async releaseKey(idempotencyKey: string): Promise<void> {
    await knex('processed_idempotency_keys').where({ key: idempotencyKey }).del();
  }
}
