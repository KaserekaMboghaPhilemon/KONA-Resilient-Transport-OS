import { knex } from '../database/knex';
import { IdempotencyRepository } from '../repositories/IdempotencyRepository';
import { TripRepository } from '../repositories/TripRepository';
import { DriverSecretRepository } from '../repositories/DriverSecretRepository';
import { CryptoSignatureEngine } from '../services/CryptoSignatureEngine';
import type { Knex } from 'knex';
import {
  IncomingLedgerRow,
  ReconciliationErrorCode,
  ServerLedgerReconciler,
} from '../services/ServerLedgerReconciler';

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

interface PreparedSyncAction {
  action: KonaSyncAction;
}

type PostCommitAction = () => Promise<void>;

export class SignatureAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureAuthenticationError';
  }
}

export class OfflineLedgerVerificationError extends Error {
  public readonly breachType: ReconciliationErrorCode | 'BATCH_SIGNATURE_INVALID';

  public readonly failedRowId?: number;

  constructor(
    breachType: ReconciliationErrorCode | 'BATCH_SIGNATURE_INVALID',
    failedRowId?: number,
  ) {
    super(`[SyncController] Offline ledger verification failed: ${breachType}.`);
    this.name = 'OfflineLedgerVerificationError';
    this.breachType = breachType;
    this.failedRowId = failedRowId;
  }
}

export interface OfflineLedgerBatchInput {
  driverId: string;
  deviceId: string;
  rows: IncomingLedgerRow[];
  batchSignatureHex: string;
  lastValidServerHash: string | null;
}

export interface OfflineLedgerIngestResult {
  success: true;
  acceptedRows: number;
}

export class SyncController {
  public static async ingestOfflineLedgerBatch(
    input: OfflineLedgerBatchInput,
  ): Promise<OfflineLedgerIngestResult> {
    const driverId = input.driverId.trim();
    const deviceId = input.deviceId.trim();

    if (!driverId) {
      throw new TypeError('[SyncController] ingestOfflineLedgerBatch requires a non-empty driverId.');
    }
    if (!deviceId) {
      throw new TypeError('[SyncController] ingestOfflineLedgerBatch requires a non-empty deviceId.');
    }
    if (!Array.isArray(input.rows)) {
      throw new TypeError('[SyncController] ingestOfflineLedgerBatch requires rows[] array input.');
    }

    const deviceSecret = await DriverSecretRepository.getSecretByDriverId(driverId);
    if (!deviceSecret) {
      throw new SignatureAuthenticationError(
        `[SyncController] No authentication secret registered for driver ${driverId}.`,
      );
    }

    const validBatchSignature = ServerLedgerReconciler.verifyBatchSignature(
      input.rows,
      input.batchSignatureHex,
      deviceSecret,
      deviceId,
    );
    if (!validBatchSignature) {
      await TripRepository.flagDriverForAudit(driverId, 'SUSPENDED_AUDIT:BATCH_SIGNATURE_INVALID');
      throw new OfflineLedgerVerificationError('BATCH_SIGNATURE_INVALID');
    }

    const reconciliation = await ServerLedgerReconciler.verifyIncomingChain(
      input.rows,
      input.lastValidServerHash,
      deviceSecret,
    );

    if (!reconciliation.success) {
      const breachType = reconciliation.error ?? 'INVALID_SIGNATURE';
      await TripRepository.flagDriverForAudit(driverId, `SUSPENDED_AUDIT:${breachType}`);
      throw new OfflineLedgerVerificationError(
        breachType,
        reconciliation.failedRowId,
      );
    }

    const preparedActions: PreparedSyncAction[] = [];
    for (const row of reconciliation.orderedRows) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(row.payload);
      } catch {
        throw new TypeError(
          `[SyncController] Invalid JSON payload in incoming row ${row.id}.`,
        );
      }
      preparedActions.push(await this.prepareAction(decoded));
    }

    const postCommitActions = await knex.transaction(async (trx) => {
      const actions: PostCommitAction[] = [];
      for (const preparedAction of preparedActions) {
        const postCommitAction = await this.executePreparedAction(preparedAction, trx);
        if (postCommitAction) {
          actions.push(postCommitAction);
        }
      }
      return actions;
    });

    await this.runPostCommitActions(postCommitActions);

    return {
      success: true,
      acceptedRows: input.rows.length,
    };
  }

  /**
   * Main entry point for processing verified, reassembled sync actions.
   * Handles idempotency defences and domain-specific routing.
   *
   * @param action  Decoded payload object from SMSReassemblyManager.
   *                Expects { idempotency_key, action_type, payload }.
   * @throws {TypeError} When required fields are missing or malformed.
   */
  public static async executeAction(action: unknown): Promise<void> {
    const preparedAction = await this.prepareAction(action);
    const postCommitActions = await knex.transaction(async (trx) => {
      const postCommitAction = await this.executePreparedAction(preparedAction, trx);
      return postCommitAction ? [postCommitAction] : [];
    });

    await this.runPostCommitActions(postCommitActions);
  }

  private static async prepareAction(action: unknown): Promise<PreparedSyncAction> {
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

    const normalizedAction = typedAction as KonaSyncAction;
    await this.verifyIncomingSignature(normalizedAction.payload, envelope);

    return { action: normalizedAction };
  }

  private static async executePreparedAction(
    preparedAction: PreparedSyncAction,
    trx: Knex.Transaction,
  ): Promise<PostCommitAction | undefined> {
    const { idempotency_key, action_type, payload } = preparedAction.action;
    const isDuplicate = await IdempotencyRepository.checkAndRegisterKey(idempotency_key, trx);
    if (isDuplicate) {
      console.warn(
        `[SyncController] Idempotency Hit! Action ${idempotency_key} already ` +
          `processed. Skipping duplicate.`,
      );
      return undefined;
    }

    console.log(
      `[SyncController] 🚀 Processing verified action [${action_type}] ` +
        `with key: ${idempotency_key}`,
    );

    let postCommitAction: PostCommitAction | undefined;
    switch (action_type) {
      case 'CREATE_TRIP':
        await TripRepository.createTripRecord(payload, trx);
        break;

      case 'START_RIDE': {
        const tripId = this.getTripId(payload, 'START_RIDE');
        await TripRepository.updateTripStatus(tripId, 'ACTIVE', trx);
        postCommitAction = () => this.startBackgroundTracking(tripId);
        break;
      }

      case 'UPDATE_FARE': {
        const tripId = this.getTripId(payload, 'UPDATE_FARE');
        const amount = Number(payload.fare_amount ?? payload.final_fare ?? payload.fare_minor);
        if (!Number.isFinite(amount)) {
          throw new TypeError('[SyncController] UPDATE_FARE requires a numeric fare field.');
        }
        await TripRepository.updateTripFare(tripId, amount, trx);
        break;
      }

      case 'END_RIDE': {
        const tripId = this.getTripId(payload, 'END_RIDE');
        await TripRepository.terminateTripLifecycle(tripId, payload, trx);
        postCommitAction = () => this.stopBackgroundTracking();
        break;
      }

      default:
        const exhaustiveCheck: never = action_type;
        throw new Error(
          `[SyncController] Unhandled action type received: ${exhaustiveCheck}`,
        );
    }

    console.log(`[SyncController] ✓ Action ${idempotency_key} completed successfully.`);
    return postCommitAction;
  }

  private static async runPostCommitActions(
    actions: PostCommitAction[],
  ): Promise<void> {
    for (const action of actions) {
      try {
        await action();
      } catch (error) {
        console.error('[SyncController] Post-commit lifecycle action failed:', error);
      }
    }
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

  private static getTripId(
    payload: Record<string, unknown>,
    actionType: 'START_RIDE' | 'UPDATE_FARE' | 'END_RIDE',
  ): string {
    const tripId = String(payload.order_id ?? payload.trip_id ?? '');
    if (!tripId) {
      throw new TypeError(
        `[SyncController] ${actionType} requires payload.order_id or payload.trip_id.`,
      );
    }

    return tripId;
  }

  private static async startBackgroundTracking(tripId: string): Promise<void> {
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

  private static async stopBackgroundTracking(): Promise<void> {
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
  }
}
