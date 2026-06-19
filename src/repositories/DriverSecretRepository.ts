import { knex } from '../database/knex';

interface DriverSecretRow {
  secret_key: string;
}

/**
 * Provides driver-scoped authentication secrets used for SMS signature checks.
 */
export class DriverSecretRepository {
  public static async getSecretByDriverId(driverId: string): Promise<string | null> {
    const normalized = driverId.trim();
    if (!normalized) {
      return null;
    }

    try {
      const row = await knex('driver_auth_secrets')
        .where({ driver_id: normalized })
        .first<DriverSecretRow>();

      if (!row || typeof row.secret_key !== 'string' || row.secret_key.trim().length === 0) {
        return null;
      }

      return row.secret_key;
    } catch (error) {
      console.error('[DriverSecretRepository] Failed to fetch driver secret:', error);
      return null;
    }
  }
}
