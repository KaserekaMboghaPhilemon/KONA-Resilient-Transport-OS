import * as SQLite from 'expo-sqlite';
import base45 from 'base45';

import { SQLiteTelemetryRepository, type TelemetryPing } from './SQLiteTelemetryRepository';
import { SMSTransportManager } from './SMSTransportManager';
import type { ConnectivityProbe, ConnectivityState } from './SyncManager';
import { resolveApiBaseUrl } from './ApiConfig';
import { CryptoSignatureEngine } from './CryptoSignatureEngine';
import { telemetrySignaturePayload } from '../utils/TelemetryAuth';

const TELEMETRY_BATCH_LIMIT = 10;

// ---------------------------------------------------------------------------
// Task 9.4 – Periodic daemon configuration
// ---------------------------------------------------------------------------
/** Baseline interval between successful sync cycles (30 s). */
export const TELEMETRY_BASE_INTERVAL_MS = 30_000;
/** Hard ceiling for exponential backoff delays (10 min). */
export const TELEMETRY_MAX_DELAY_MS = 600_000;

interface TelemetryBatchPayload {
  trip_id: string;
  payload_b45: string;
  point_count: number;
  idempotency_key: string;
}

interface TelemetrySyncDependencies {
  connectivityProbe: ConnectivityProbe;
  apiBaseUrl?: string;
  getDeviceSecret: () => Promise<string>;
  getDriverId: () => Promise<string>;
}

/**
 * Sprint 9 – Telemetry Slicing, Backoff, and Batch Transport Processing
 *
 * Pulls buffered raw GPS pings from SQLite, compresses them into a compact
 * delimited wire format, Base45-encodes the payload, and dispatches through
 * adaptive transport routing (HTTPS or SMS).
 */
export class TelemetrySyncManager {
  private static telemetryRepositoryPromise: Promise<SQLiteTelemetryRepository> | null = null;

  // ---------------------------------------------------------------------------
  // Task 9.4 – Periodic daemon state
  // ---------------------------------------------------------------------------
  /** Active timer handle; null when daemon is idle. */
  private static periodicTimerHandle: ReturnType<typeof setTimeout> | null = null;
  /** Trip ID currently being tracked by the daemon. */
  private static periodicTripId: string | null = null;
  private static activeSyncs = new Map<string, Promise<void>>();
  /** Consecutive failures since the last successful cycle. */
  private static consecutiveFailures = 0;
  /** Timestamp (ms since epoch) when the next sync cycle will fire. */
  private static nextSyncTimestamp: number | null = null;

  // Defaults are intentionally safe: without an injected probe, no connectivity
  // is assumed so telemetry will flow through SMS fallback logic.
  private static dependencies: TelemetrySyncDependencies = {
    connectivityProbe: {
      getState: () => 'none',
    },
    getDeviceSecret: async () => {
      throw new Error('[TelemetrySyncManager] Device secret provider is not configured.');
    },
    getDriverId: async () => {
      throw new Error('[TelemetrySyncManager] Driver identity provider is not configured.');
    },
  };

  /**
   * Allows app bootstrap code to inject the active connectivity probe and API base URL.
   */
  public static configure(params: Partial<TelemetrySyncDependencies>): void {
    this.dependencies = {
      ...this.dependencies,
      ...params,
    };
  }

  // ---------------------------------------------------------------------------
  // Task 9.4 – Periodic Sync Daemon
  // ---------------------------------------------------------------------------

  /**
   * Starts the recurring telemetry batch pump for the given trip.
   *
   * Resets failures only when switching trips and schedules the first execution
   * at the baseline interval. Each cycle calls processTelemetrySync()
   * and re-schedules itself:
   *  - On success or no-op → resets failures → next tick at TELEMETRY_BASE_INTERVAL_MS.
   *  - On exception → increments failures → next tick at min(base × 2^failures, max).
   *
   * Calling startPeriodicSync() while a daemon is already running replaces the
   * timer without discarding the same trip's accumulated retry state.
   */
  public static startPeriodicSync(tripId: string): void {
    const normalizedTripId = tripId.trim();
    if (!normalizedTripId) {
      throw new TypeError('[TelemetrySyncManager] startPeriodicSync requires a non-empty tripId.');
    }

    const sameTrip = this.periodicTripId === normalizedTripId;
    this.stopPeriodicSync();

    this.periodicTripId = normalizedTripId;
    if (!sameTrip) {
      this.consecutiveFailures = 0;
    }

    console.log(
      `[TelemetrySyncManager] Starting periodic telemetry daemon for trip ${normalizedTripId} ` +
        `(base interval ${TELEMETRY_BASE_INTERVAL_MS} ms).`,
    );

    this.scheduleNextCycle(TELEMETRY_BASE_INTERVAL_MS);
  }

  /**
   * Stops the daemon loop and clears the active timer handle.
   * Safe to call even when no daemon is running.
   */
  public static stopPeriodicSync(): void {
    if (this.periodicTimerHandle !== null) {
      clearTimeout(this.periodicTimerHandle);
      this.periodicTimerHandle = null;
    }
    this.periodicTripId = null;
    this.nextSyncTimestamp = null;
    console.log('[TelemetrySyncManager] Periodic telemetry daemon stopped.');
  }

  /**
   * Computes the next backoff interval after a given number of consecutive failures.
   *
   * Formula: min(TELEMETRY_BASE_INTERVAL_MS × 2^consecutiveFailures, TELEMETRY_MAX_DELAY_MS)
   */
  public static computeBackoffDelay(consecutiveFailures: number): number {
    const backoff = TELEMETRY_BASE_INTERVAL_MS * Math.pow(2, consecutiveFailures);
    return Math.min(backoff, TELEMETRY_MAX_DELAY_MS);
  }

  /**
   * Schedules a single tick of the sync daemon after `delayMs` milliseconds.
   * The tick runs processTelemetrySync() and immediately re-schedules itself.
   */
  private static scheduleNextCycle(delayMs: number): void {
    if (this.periodicTimerHandle !== null) {
      clearTimeout(this.periodicTimerHandle);
    }
    this.nextSyncTimestamp = Date.now() + delayMs;
    this.periodicTimerHandle = setTimeout(() => {
      this.periodicTimerHandle = null;
      void this.runOneCycle();
    }, delayMs);
  }

  // ---------------------------------------------------------------------------
  // Task 10 – UI Observability & Manual Override
  // ---------------------------------------------------------------------------

  /**
   * Exposes the current consecutive failure count for UI telemetry display.
   */
  public static getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Returns the timestamp (ms since epoch) when the next sync cycle will fire,
   * or null if no daemon is active.
   */
  public static getNextSyncTimestamp(): number | null {
    return this.nextSyncTimestamp;
  }

  /**
   * Returns the count of unsynced telemetry pings for the given trip.
   */
  public static async getUnsyncedPingCount(tripId: string): Promise<number> {
    const repository = await this.getTelemetryRepository();
    return repository.countUnsyncedPings(tripId);
  }

  /**
   * Manually triggers an immediate telemetry sync, bypassing the current delay.
   * Success resets backoff; failure records backoff, schedules retry, and rejects.
   *
   * Safe to call multiple times; internally guards against concurrent execution.
   */
  public static async forceTelemetrySync(tripId: string): Promise<void> {
    const normalizedTripId = tripId.trim();
    if (!normalizedTripId) {
      throw new TypeError('[TelemetrySyncManager] forceTelemetrySync requires a non-empty tripId.');
    }

    if (this.activeSyncs.has(normalizedTripId)) {
      return this.activeSyncs.get(normalizedTripId);
    }

    if (this.periodicTimerHandle !== null) {
      clearTimeout(this.periodicTimerHandle);
      this.periodicTimerHandle = null;
    }

    this.periodicTripId = normalizedTripId;
    try {
      console.log(
        `[TelemetrySyncManager] Manual flush triggered for trip ${normalizedTripId}. ` +
          `Attempting an immediate sync.`,
      );

      await this.processTelemetrySync(normalizedTripId);

      this.consecutiveFailures = 0;
      this.scheduleNextCycle(TELEMETRY_BASE_INTERVAL_MS);

      console.log(
        `[TelemetrySyncManager] Manual flush complete. ` +
          `Next sync in ${TELEMETRY_BASE_INTERVAL_MS} ms.`,
      );
    } catch (error) {
      console.error(
        `[TelemetrySyncManager] Manual flush failed for trip ${normalizedTripId}:`,
        error,
      );
      this.consecutiveFailures += 1;
      this.scheduleNextCycle(this.computeBackoffDelay(this.consecutiveFailures));
      throw error;
    }
  }

  /**
   * Executes one telemetry sync cycle and schedules the subsequent tick unless stopped.
   */
  private static async runOneCycle(): Promise<void> {
    const tripId = this.periodicTripId;

    // Guard: daemon may have been stopped between the timer firing and this tick running.
    if (tripId === null) {
      return;
    }

    try {
      await this.processTelemetrySync(tripId);
      if (this.periodicTripId !== tripId) {
        return;
      }

      // Cycle completed without throwing — treat as success regardless of whether
      // any rows were found (a no-op empty batch is still a healthy execution).
      this.consecutiveFailures = 0;
      this.scheduleNextCycle(TELEMETRY_BASE_INTERVAL_MS);

      console.log(
        `[TelemetrySyncManager] Cycle complete for trip ${tripId}. ` +
          `Next cycle in ${TELEMETRY_BASE_INTERVAL_MS} ms.`,
      );
    } catch (cycleError) {
      if (this.periodicTripId !== tripId) {
        return;
      }

      this.consecutiveFailures += 1;
      const nextDelay = this.computeBackoffDelay(this.consecutiveFailures);

      console.warn(
        `[TelemetrySyncManager] Cycle failed for trip ${tripId} ` +
          `(failure #${this.consecutiveFailures}). ` +
          `Backing off ${nextDelay} ms before next cycle.`,
        cycleError,
      );

      this.scheduleNextCycle(nextDelay);
    }
  }
  public static async processTelemetrySync(tripId: string): Promise<void> {
    const normalizedTripId = tripId.trim();
    if (!normalizedTripId) {
      throw new TypeError('[TelemetrySyncManager] processTelemetrySync requires a non-empty tripId.');
    }

    const activeSync = this.activeSyncs.get(normalizedTripId);
    if (activeSync) {
      return activeSync;
    }

    const syncPromise = this.processTelemetryBatch(normalizedTripId);
    this.activeSyncs.set(normalizedTripId, syncPromise);
    try {
      await syncPromise;
    } finally {
      if (this.activeSyncs.get(normalizedTripId) === syncPromise) {
        this.activeSyncs.delete(normalizedTripId);
      }
    }
  }

  private static async processTelemetryBatch(normalizedTripId: string): Promise<void> {
    const repository = await this.getTelemetryRepository();
    const batch = await repository.getUnsyncedPings(
      normalizedTripId,
      TELEMETRY_BATCH_LIMIT,
    );

    if (batch.length === 0) {
      console.log(
        `[TelemetrySyncManager] No unsynced telemetry rows for trip ${normalizedTripId}.`,
      );
      return;
    }

    const serialized = this.serializeTelemetrySlice(normalizedTripId, batch);
    const encodedPayload = this.base45Encode(serialized);
    const deviceSecret = await this.dependencies.getDeviceSecret();
    const idempotencyKey = await CryptoSignatureEngine.generateStrongSignature(
      `${normalizedTripId}\n${batch.map((ping) => ping.id ?? '').join(',')}\n${encodedPayload}`,
      deviceSecret,
    );

    const networkState = await this.resolveConnectivityState();
    const dispatched = await this.dispatchBatch(
      normalizedTripId,
      encodedPayload,
      batch.length,
      idempotencyKey,
      networkState,
    );

    if (!dispatched) {
      throw new Error(
        `[TelemetrySyncManager] Telemetry batch was not acknowledged by the server for trip ${normalizedTripId}.`,
      );
    }

    const idsToClear = batch
      .map((ping) => ping.id)
      .filter((id): id is number => typeof id === 'number');

    await repository.clearSyncedPings(idsToClear);

    console.log(
      `[TelemetrySyncManager] Cleared ${idsToClear.length} server-acknowledged telemetry row(s) ` +
        `for trip ${normalizedTripId}.`,
    );
  }

  /**
   * Packs telemetry points to: TRIP_ID|LAT,LNG,SPEED,TIME;LAT,LNG,SPEED,TIME
   */
  private static serializeTelemetrySlice(tripId: string, pings: TelemetryPing[]): string {
    const points = pings.map((ping) => {
      const lat = this.toCompactDecimal(ping.latitude, 6);
      const lng = this.toCompactDecimal(ping.longitude, 6);
      const speed = ping.speed === null ? '' : this.toCompactDecimal(ping.speed, 2);
      const timestamp = Math.trunc(ping.timestamp);

      return `${lat},${lng},${speed},${timestamp}`;
    });

    return `${tripId}|${points.join(';')}`;
  }

  private static toCompactDecimal(value: number, precision: number): string {
    if (!Number.isFinite(value)) {
      return '0';
    }

    return Number(value.toFixed(precision)).toString();
  }

  private static base45Encode(raw: string): string {
    return base45.encode(Buffer.from(raw, 'utf8'));
  }

  private static async resolveConnectivityState(): Promise<ConnectivityState> {
    try {
      return await this.dependencies.connectivityProbe.getState();
    } catch (probeError) {
      console.warn(
        '[TelemetrySyncManager] Connectivity probe failed. Falling back to sms_only path.',
        probeError,
      );
      return 'sms_only';
    }
  }

  private static async dispatchBatch(
    tripId: string,
    encodedPayload: string,
    pointCount: number,
    idempotencyKey: string,
    state: ConnectivityState,
  ): Promise<boolean> {
    if (state === 'internet') {
      return this.dispatchViaHttps(tripId, encodedPayload, pointCount, idempotencyKey);
    }

    if (state === 'sms_only' || state === 'none') {
      return this.dispatchViaSms(tripId, encodedPayload, pointCount, idempotencyKey);
    }

    return false;
  }

  private static async dispatchViaHttps(
    tripId: string,
    encodedPayload: string,
    pointCount: number,
    idempotencyKey: string,
  ): Promise<boolean> {
    const endpoint = `${(this.dependencies.apiBaseUrl ?? resolveApiBaseUrl()).replace(/\/$/, '')}/api/v1/telemetry/batch`;

    const payload: TelemetryBatchPayload = {
      trip_id: tripId,
      payload_b45: encodedPayload,
      point_count: pointCount,
      idempotency_key: idempotencyKey,
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Kona-Driver-Id': await this.dependencies.getDriverId(),
          'X-Kona-Signature': await CryptoSignatureEngine.generateStrongSignature(
            telemetrySignaturePayload(payload),
            await this.dependencies.getDeviceSecret(),
          ),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status !== 200) {
        console.warn(
          `[TelemetrySyncManager] HTTPS telemetry batch rejected with status ${response.status}.`,
        );
        return false;
      }

      const acknowledgement: unknown = await response.json();
      if (
        !acknowledgement ||
        typeof acknowledgement !== 'object' ||
        (acknowledgement as Record<string, unknown>).status !== 'ok' ||
        (acknowledgement as Record<string, unknown>).acceptedPoints !== pointCount
      ) {
        console.warn('[TelemetrySyncManager] HTTPS telemetry acknowledgement was invalid.');
        return false;
      }
      return true;
    } catch (httpError) {
      console.error('[TelemetrySyncManager] HTTPS telemetry batch transport failed:', httpError);
      return false;
    }
  }

  private static async dispatchViaSms(
    tripId: string,
    encodedPayload: string,
    pointCount: number,
    idempotencyKey: string,
  ): Promise<boolean> {
    try {
      const smsTransport = await SMSTransportManager.create();
      const envelope = base45.encode(
        Buffer.from(
          JSON.stringify({
            message_type: 'TELEMETRY_BATCH',
            trip_id: tripId,
            payload_b45: encodedPayload,
            point_count: pointCount,
            idempotency_key: idempotencyKey,
          }),
          'utf8',
        ),
      );
      const acceptedByCarrier = await smsTransport.sendPayloadAsChunks(
        envelope,
        'TELEMETRY',
        await this.dependencies.getDeviceSecret(),
      );
      if (acceptedByCarrier) {
        console.warn(
          '[TelemetrySyncManager] SMS carrier accepted the batch, but no server acknowledgement is available; retaining local points.',
        );
      }
      return false;
    } catch (smsError) {
      console.error('[TelemetrySyncManager] SMS telemetry batch transport failed:', smsError);
      return false;
    }
  }

  private static async getTelemetryRepository(): Promise<SQLiteTelemetryRepository> {
    if (!this.telemetryRepositoryPromise) {
      this.telemetryRepositoryPromise = (async () => {
        const db = await SQLite.openDatabaseAsync('kona_offline_cache.db');
        const repository = new SQLiteTelemetryRepository(db);
        await repository.initialize();
        return repository;
      })();
    }

    return this.telemetryRepositoryPromise;
  }
}
