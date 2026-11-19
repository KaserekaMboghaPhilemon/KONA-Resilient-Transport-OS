import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SQLite from 'expo-sqlite';

import {
  SQLiteTelemetryRepository,
  type TelemetryPing,
} from './SQLiteTelemetryRepository';
import {
  clearPersistedActiveTripId,
  getPersistedActiveTripId,
  initDatabase,
  persistActiveTripId,
} from '../db/LocalDatabase';

export const KONA_BACKGROUND_LOCATION_TASK = 'KONA_BACKGROUND_LOCATION';

interface BackgroundLocationTaskData {
  locations?: Location.LocationObject[];
}

export class BackgroundLocationWorker {
  private static activeTripId: string | null = null;
  private static startTrackingPromise: Promise<void> | null = null;
  private static telemetryRepositoryPromise: Promise<SQLiteTelemetryRepository> | null = null;

  /**
   * Starts OS-managed background location updates for a trip.
   */
  public static async startTracking(tripId: string): Promise<void> {
    const normalizedTripId = tripId.trim();
    if (!normalizedTripId) {
      throw new TypeError('[BackgroundLocationWorker] startTracking requires a non-empty tripId.');
    }

    if (this.activeTripId === normalizedTripId) {
      return;
    }

    if (this.startTrackingPromise) {
      await this.startTrackingPromise;
      if (this.activeTripId === normalizedTripId) {
        return;
      }
    }

    const operation = this.startTrackingInternal(normalizedTripId);
    this.startTrackingPromise = operation;
    try {
      await operation;
    } finally {
      if (this.startTrackingPromise === operation) {
        this.startTrackingPromise = null;
      }
    }
  }

  private static async startTrackingInternal(normalizedTripId: string): Promise<void> {
    const foregroundPermission = await Location.requestForegroundPermissionsAsync();
    if (foregroundPermission.status !== 'granted') {
      throw new Error('[BackgroundLocationWorker] Foreground location permission was denied.');
    }

    const backgroundPermission = await Location.requestBackgroundPermissionsAsync();
    if (backgroundPermission.status !== 'granted') {
      throw new Error('[BackgroundLocationWorker] Background location permission was denied.');
    }

    await initDatabase();
    const previousTripId = await getPersistedActiveTripId();
    await persistActiveTripId(normalizedTripId);
    this.activeTripId = normalizedTripId;

    try {
      const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(
        KONA_BACKGROUND_LOCATION_TASK,
      );
      if (!alreadyStarted) {
        await Location.startLocationUpdatesAsync(KONA_BACKGROUND_LOCATION_TASK, {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 5000,
          deferredUpdatesInterval: 10000,
          foregroundService: {
            notificationTitle: 'KONA Tracking Active',
            notificationBody: 'Recording route telemetry safely offline',
          },
        });
      }
    } catch (error) {
      if (previousTripId) {
        await persistActiveTripId(previousTripId);
      } else {
        await clearPersistedActiveTripId(normalizedTripId);
      }
      this.activeTripId = previousTripId;
      throw error;
    }
  }

  public static async restoreActiveTrip(): Promise<string | null> {
    await initDatabase();
    const persistedTripId = await getPersistedActiveTripId();
    if (!persistedTripId) {
      this.activeTripId = null;
      return null;
    }

    await this.startTracking(persistedTripId);
    return persistedTripId;
  }

  public static async resolveActiveTripId(): Promise<string | null> {
    if (this.activeTripId) {
      return this.activeTripId;
    }

    await initDatabase();
    this.activeTripId = await getPersistedActiveTripId();
    return this.activeTripId;
  }

  /**
   * Stops background location updates and clears active trip context.
   */
  public static async stopTracking(): Promise<void> {
    if (this.startTrackingPromise) {
      await this.startTrackingPromise;
    }

    const stoppedTripId = this.activeTripId;
    const started = await Location.hasStartedLocationUpdatesAsync(
      KONA_BACKGROUND_LOCATION_TASK,
    );

    if (started) {
      await Location.stopLocationUpdatesAsync(KONA_BACKGROUND_LOCATION_TASK);
    }

    await initDatabase();
    await clearPersistedActiveTripId(stoppedTripId ?? undefined);
    this.activeTripId = null;
  }

  /**
   * Returns the currently tracked trip id for the global task callback.
   */
  public static getActiveTripId(): string | null {
    return this.activeTripId;
  }

  /**
   * Persists a batch of location updates to the local telemetry buffer.
   */
  public static async persistLocations(
    tripId: string,
    locations: Location.LocationObject[],
  ): Promise<void> {
    if (locations.length === 0) {
      return;
    }

    const repository = await this.getTelemetryRepository();
    for (const location of locations) {
      const ping = this.buildTelemetryPing(tripId, location);
      await repository.logPing(ping);
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

  private static numberOrNull(value: unknown): number | null {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return null;
    }
    return value;
  }

  private static buildTelemetryPing(
    tripId: string,
    location: Location.LocationObject,
  ): TelemetryPing {
    return {
      tripId,
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      speed: this.numberOrNull(location.coords.speed),
      heading: this.numberOrNull(location.coords.heading),
      timestamp:
        typeof location.timestamp === 'number'
          ? location.timestamp
          : Date.now(),
    };
  }
}

if (!TaskManager.isTaskDefined(KONA_BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask(
    KONA_BACKGROUND_LOCATION_TASK,
    async ({ data, error }: TaskManager.TaskManagerTaskBody) => {
      if (error) {
        console.error('[BackgroundLocationWorker] Task error:', error.message);
        return;
      }

      let tripId: string | null;
      try {
        tripId = await BackgroundLocationWorker.resolveActiveTripId();
      } catch (taskError) {
        console.error(
          '[BackgroundLocationWorker] Failed to resolve persisted trip context:',
          taskError,
        );
        return;
      }

      if (!tripId) {
        console.warn(
          '[BackgroundLocationWorker] Received background location with no active tripId; dropping sample.',
        );
        return;
      }

      const payload = data as BackgroundLocationTaskData | null;
      const locations = payload?.locations ?? [];
      if (locations.length === 0) {
        return;
      }

      try {
        await BackgroundLocationWorker.persistLocations(tripId, locations);
      } catch (taskError) {
        console.error('[BackgroundLocationWorker] Failed to persist telemetry ping(s):', taskError);
      }
    },
  );
}
