import * as SQLite from 'expo-sqlite';
import base45 from 'base45';

import { SQLiteTelemetryRepository, type TelemetryPing } from './SQLiteTelemetryRepository';
import { SMSTransportManager } from './SMSTransportManager';
import type { ConnectivityProbe, ConnectivityState } from './SyncManager';

const TELEMETRY_BATCH_LIMIT = 10;
const DEFAULT_API_BASE_URL = 'http://localhost:3000';

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
}

interface TelemetrySyncDependencies {
  connectivityProbe: ConnectivityProbe;
  apiBaseUrl: string;
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
  /** Consecutive failures since the last successful cycle. */
  private static consecutiveFailures = 0;

  // Defaults are intentionally safe: without an injected probe, no connectivity
  // is assumed so telemetry will flow through SMS fallback logic.
  private static dependencies: TelemetrySyncDependencies = {
    connectivityProbe: {
      getState: () => 'none',
    },
    apiBaseUrl: DEFAULT_API_BASE_URL,
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
   * Resets the consecutive-failure counter and schedules the first execution
   * immediately at the baseline interval. Each cycle calls processTelemetrySync()
   * and re-schedules itself:
   *  - On success or no-op → resets failures → next tick at TELEMETRY_BASE_INTERVAL_MS.
   *  - On exception → increments failures → next tick at min(base × 2^failures, max).
   *
   * Calling startPeriodicSync() while a daemon is already running replaces the
   * existing loop (the prior timer is cleared before the new one is installed).
   */
  public static startPeriodicSync(tripId: string): void {
    const normalizedTripId = tripId.trim();
    if (!normalizedTripId) {
      throw new TypeError('[TelemetrySyncManager] startPeriodicSync requires a non-empty tripId.');
    }

    // Clear any existing daemon loop before replacing it.
    this.stopPeriodicSync();

    this.periodicTripId = normalizedTripId;
    this.consecutiveFailures = 0;

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
    this.periodicTimerHandle = setTimeout(() => {
      void this.runOneCycle();
    }, delayMs);
  }

  /**
   * Executes one telemetry sync cycle and schedules the subsequent tick.
   */
  private static async runOneCycle(): Promise<void> {
    const tripId = this.periodicTripId;

    // Guard: daemon may have been stopped between the timer firing and this tick running.
    if (tripId === null) {
      return;
    }

    try {
      await this.processTelemetrySync(tripId);

      // Cycle completed without throwing — treat as success regardless of whether
      // any rows were found (a no-op empty batch is still a healthy execution).
      this.consecutiveFailures = 0;
      this.scheduleNextCycle(TELEMETRY_BASE_INTERVAL_MS);

      console.log(
        `[TelemetrySyncManager] Cycle complete for trip ${tripId}. ` +
          `Next cycle in ${TELEMETRY_BASE_INTERVAL_MS} ms.`,
      );
    } catch (cycleError) {
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

    try {
      const repository = await this.getTelemetryRepository();
      const unsynced = await repository.getUnsyncedPings(normalizedTripId);
      const batch = unsynced.slice(0, TELEMETRY_BATCH_LIMIT);

      if (batch.length === 0) {
        console.log(
          `[TelemetrySyncManager] No unsynced telemetry rows for trip ${normalizedTripId}.`,
        );
        return;
      }

      const serialized = this.serializeTelemetrySlice(normalizedTripId, batch);
      const encodedPayload = this.base45Encode(serialized);

      const networkState = await this.resolveConnectivityState();
      const dispatched = await this.dispatchBatch(
        normalizedTripId,
        encodedPayload,
        batch.length,
        networkState,
      );

      if (!dispatched) {
        console.warn(
          `[TelemetrySyncManager] Batch dispatch not acknowledged for trip ${normalizedTripId}.`,
        );
        return;
      }

      const idsToClear = batch
        .map((ping) => ping.id)
        .filter((id): id is number => typeof id === 'number');

      await repository.clearSyncedPings(idsToClear);

      console.log(
        `[TelemetrySyncManager] Cleared ${idsToClear.length} synced telemetry row(s) ` +
          `for trip ${normalizedTripId}.`,
      );
    } catch (error) {
      console.error(
        `[TelemetrySyncManager] Telemetry sync cycle failed for trip ${normalizedTripId}:`,
        error,
      );
    }
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
    state: ConnectivityState,
  ): Promise<boolean> {
    if (state === 'internet') {
      return this.dispatchViaHttps(tripId, encodedPayload, pointCount);
    }

    if (state === 'sms_only' || state === 'none') {
      return this.dispatchViaSms(encodedPayload);
    }

    return false;
  }

  private static async dispatchViaHttps(
    tripId: string,
    encodedPayload: string,
    pointCount: number,
  ): Promise<boolean> {
    const endpoint = `${this.dependencies.apiBaseUrl.replace(/\/$/, '')}/api/v1/telemetry/batch`;

    const payload: TelemetryBatchPayload = {
      trip_id: tripId,
      payload_b45: encodedPayload,
      point_count: pointCount,
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.status !== 200) {
        console.warn(
          `[TelemetrySyncManager] HTTPS telemetry batch rejected with status ${response.status}.`,
        );
        return false;
      }

      return true;
    } catch (httpError) {
      console.error('[TelemetrySyncManager] HTTPS telemetry batch transport failed:', httpError);
      return false;
    }
  }

  private static async dispatchViaSms(encodedPayload: string): Promise<boolean> {
    try {
      const smsTransport = await SMSTransportManager.create();
      return smsTransport.sendPayloadAsChunks(encodedPayload, 'TELEMETRY');
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
