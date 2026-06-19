import { IdempotencyRepository } from '../repositories/IdempotencyRepository';
import { TripRepository } from '../repositories/TripRepository';
import { DriverSecretRepository } from '../repositories/DriverSecretRepository';
import { CryptoSignatureEngine } from '../services/CryptoSignatureEngine';

/**
 * Sprint 7.5 – SyncController: PostgreSQL transaction routing matrix
 *
 * Receives fully-reassembled sync actions and routes them through explicit
 * Knex-powered repository calls.
 *
 * Integration with Sprint 8.5 – Lifecycle Binding:
 * Hooks the BackgroundLocationWorker into START_RIDE and END_RIDE transitions
 * to manage native GPS tracking lifecycle across trip state changes.
 */

/**
 * Canonical shape of a verified, reassembled sync action.
 * Produced by SMSReassemblyManager.processIncomingSegment() after Base45
 * decode and JSON.parse().
 */
export interface KonaSyncAction {
  /** UUID or transaction ID for idempotency defence. */
  idempotency_key: string;
  /** Domain action type that determines routing. */
  action_type: 'CREATE_TRIP' | 'START_RIDE' | 'UPDATE_FARE' | 'END_RIDE';
  /** Action-specific parameters; structure varies by action_type. */
  payload: Record<string, unknown>;
}

interface KonaSecurityEnvelope {
  __kona_signature_hex?: unknown;
  __kona_raw_wire?: unknown;
}

export class SignatureAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureAuthenticationError';
  }
}

export class SyncController {
  /**
   * Main entry point for processing verified, reassembled sync actions.
   * Handles idempotency defences and domain-specific routing.
   *
   * @param action  Decoded payload object from SMSReassemblyManager.
   *                Expects { idempotency_key, action_type, payload }.
   * @throws {TypeError} When required fields are missing or malformed.
   */
  public static async executeAction(action: unknown): Promise<void> {
    if (!action || typeof action !== 'object') {
      throw new TypeError(
        '[SyncController] Invalid action format: Action must be an object.',
      );
    }

    const typedAction = action as Partial<KonaSyncAction>;
    const envelope = action as KonaSecurityEnvelope;

    if (
      typeof typedAction.idempotency_key !== 'string' ||
      typedAction.idempotency_key.trim().length === 0
    ) {
      throw new TypeError(
        '[SyncController] Missing or malformed required field: "idempotency_key".',
      );
    }
    if (
      typedAction.action_type !== 'CREATE_TRIP' &&
      typedAction.action_type !== 'START_RIDE' &&
      typedAction.action_type !== 'UPDATE_FARE' &&
      typedAction.action_type !== 'END_RIDE'
    ) {
      throw new TypeError(
        '[SyncController] Missing or malformed required field: "action_type".',
      );
    }
    if (
      !typedAction.payload ||
      typeof typedAction.payload !== 'object' ||
      Array.isArray(typedAction.payload)
    ) {
      throw new TypeError('[SyncController] Missing or malformed required field: "payload".');
    }

    const { idempotency_key, action_type, payload } =
      typedAction as KonaSyncAction;

    await this.verifyIncomingSignature(payload, envelope);

    const isDuplicate = await IdempotencyRepository.checkAndRegisterKey(
      idempotency_key,
    );
    if (isDuplicate) {
      console.warn(
        `[SyncController] Idempotency Hit! Action ${idempotency_key} already ` +
          `processed. Skipping duplicate.`,
      );
      return;
    }

    console.log(
      `[SyncController] 🚀 Processing verified action [${action_type}] ` +
        `with key: ${idempotency_key}`,
    );

    try {
      switch (action_type) {
        case 'CREATE_TRIP':
          await this.handleCreateTrip(payload);
          break;

        case 'START_RIDE':
          await this.handleStartRide(payload);
          break;

        case 'UPDATE_FARE':
          await this.handleUpdateFare(payload);
          break;

        case 'END_RIDE':
          await this.handleEndRide(payload);
          break;

        default:
          const exhaustiveCheck: never = action_type;
          throw new Error(
            `[SyncController] Unhandled action type received: ${exhaustiveCheck}`,
          );
      }
    } catch (error) {
      await IdempotencyRepository.releaseKey(idempotency_key);
      throw error;
    }

    console.log(`[SyncController] ✓ Action ${idempotency_key} completed successfully.`);
  }

  /**
   * Sprint 11.5 — cryptographic gate before any database mutation.
   */
  private static async verifyIncomingSignature(
    payload: Record<string, unknown>,
    envelope: KonaSecurityEnvelope,
  ): Promise<void> {
    const incomingSignature =
      typeof envelope.__kona_signature_hex === 'string'
        ? envelope.__kona_signature_hex.trim().toUpperCase()
        : '';

    // Legacy payloads with no signature metadata remain accepted.
    if (!incomingSignature) {
      return;
    }

    if (!/^[A-F0-9]{8}$/.test(incomingSignature)) {
      throw new SignatureAuthenticationError(
        '[SyncController] Invalid incoming signature format.',
      );
    }

    const rawWirePayload =
      typeof envelope.__kona_raw_wire === 'string' ? envelope.__kona_raw_wire : '';
    if (!rawWirePayload) {
      throw new SignatureAuthenticationError(
        '[SyncController] Missing signed wire payload for verification.',
      );
    }

    const driverId =
      typeof payload.driver_id === 'string' ? payload.driver_id.trim() : '';
    if (!driverId) {
      throw new SignatureAuthenticationError(
        '[SyncController] Missing payload.driver_id for signature verification.',
      );
    }

    const secret = await DriverSecretRepository.getSecretByDriverId(driverId);
    if (!secret) {
      throw new SignatureAuthenticationError(
        `[SyncController] No authentication secret registered for driver ${driverId}.`,
      );
    }

    const expectedSignature = await CryptoSignatureEngine.generateSignature(
      rawWirePayload,
      secret,
    );

    if (expectedSignature !== incomingSignature) {
      throw new SignatureAuthenticationError(
        `[SyncController] Signature verification failed for driver ${driverId}.`,
      );
    }
  }

  /**
   * Handles CREATE_TRIP action: writes a new trip assignment record.
   */
  private static async handleCreateTrip(
    payload: Record<string, unknown>,
  ): Promise<void> {
    await TripRepository.createTripRecord(payload);
  }

  /**
   * Handles START_RIDE action: transitions trip from ASSIGNED to ACTIVE.
   * Also triggers native background location tracking (Sprint 8.5).
   */
  private static async handleStartRide(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const tripId = String(payload.order_id ?? payload.trip_id ?? '');
    if (!tripId) {
      throw new TypeError('[SyncController] START_RIDE requires payload.order_id or payload.trip_id.');
    }

    // Update trip status in database
    await TripRepository.updateTripStatus(tripId, 'ACTIVE');

    // Trigger native background GPS tracking (Sprint 8.5 – Lifecycle Binding)
    // Using dynamic import to avoid loading expo dependencies at module init time
    console.log(
      `[SyncController] 🚗 Activating native background telemetry stream for trip: ${tripId}`,
    );
    try {
      const { BackgroundLocationWorker } = await import('../services/BackgroundLocationWorker');
      await BackgroundLocationWorker.startTracking(tripId);
    } catch (trackerError) {
      console.error(
        `[SyncController] Failed to start background location tracking for trip ${tripId}:`,
        trackerError,
      );
      // Do not re-throw; the trip is active even if tracking init fails.
      // The app will attempt recovery on next boot if tracking remains unavailable.
    }
  }

  /**
   * Handles UPDATE_FARE action: updates the fare amount for a trip.
   */
  private static async handleUpdateFare(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const tripId = String(payload.order_id ?? payload.trip_id ?? '');
    const amount = Number(payload.fare_amount ?? payload.final_fare ?? payload.fare_minor);

    if (!tripId) {
      throw new TypeError('[SyncController] UPDATE_FARE requires payload.order_id or payload.trip_id.');
    }
    if (!Number.isFinite(amount)) {
      throw new TypeError('[SyncController] UPDATE_FARE requires a numeric fare field.');
    }

    await TripRepository.updateTripFare(tripId, amount);
  }

  /**
   * Handles END_RIDE action: finalizes trip lifecycle and settlement ledger.
   * Also deactivates native background location tracking (Sprint 8.5).
   */
  private static async handleEndRide(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const tripId = String(payload.order_id ?? payload.trip_id ?? '');
    if (!tripId) {
      throw new TypeError('[SyncController] END_RIDE requires payload.order_id or payload.trip_id.');
    }

    // Stop native background GPS tracking (Sprint 8.5 – Lifecycle Binding)
    // Using dynamic import to avoid loading expo dependencies at module init time
    console.log(
      '[SyncController] 🛑 Deactivating native background telemetry stream safely.',
    );
    try {
      const { BackgroundLocationWorker } = await import('../services/BackgroundLocationWorker');
      await BackgroundLocationWorker.stopTracking();
    } catch (trackerError) {
      console.error(
        '[SyncController] Failed to stop background location tracking:',
        trackerError,
      );
      // Do not re-throw; finalize the trip even if tracking stop fails.
    }

    // Finalize trip lifecycle and settlement
    await TripRepository.terminateTripLifecycle(tripId, payload);
  }
}
