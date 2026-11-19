jest.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  PermissionStatus: { GRANTED: 'granted' },
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestBackgroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  hasStartedLocationUpdatesAsync: jest.fn().mockResolvedValue(false),
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-task-manager', () => ({
  isTaskDefined: jest.fn().mockReturnValue(true),
  defineTask: jest.fn(),
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

jest.mock('../SQLiteTelemetryRepository', () => ({
  SQLiteTelemetryRepository: jest.fn(),
}));

jest.mock('../../db/LocalDatabase', () => ({
  initDatabase: jest.fn().mockResolvedValue({}),
  persistActiveTripId: jest.fn().mockResolvedValue(undefined),
  getPersistedActiveTripId: jest.fn().mockResolvedValue('trip-persisted'),
  clearPersistedActiveTripId: jest.fn().mockResolvedValue(undefined),
}));

import * as Location from 'expo-location';
import {
  clearPersistedActiveTripId,
  persistActiveTripId,
} from '../../db/LocalDatabase';
import { BackgroundLocationWorker } from '../BackgroundLocationWorker';

const mockPersistActiveTripId = jest.mocked(persistActiveTripId);

describe('BackgroundLocationWorker trip persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(false);
    jest.mocked(Location.requestForegroundPermissionsAsync).mockResolvedValue({
      status: Location.PermissionStatus.GRANTED,
      granted: true,
      canAskAgain: true,
      expires: 'never',
    });
    jest.mocked(Location.requestBackgroundPermissionsAsync).mockResolvedValue({
      status: Location.PermissionStatus.GRANTED,
      granted: true,
      canAskAgain: true,
      expires: 'never',
    });
  });

  it('persists trip context before starting OS location updates and clears it on stop', async () => {
    await BackgroundLocationWorker.startTracking(' trip-live-001 ');

    expect(persistActiveTripId).toHaveBeenCalledWith('trip-live-001');
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledWith(
      'KONA_BACKGROUND_LOCATION',
      expect.objectContaining({
        timeInterval: 5000,
        deferredUpdatesInterval: 10000,
      }),
    );
    expect(mockPersistActiveTripId.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(Location.startLocationUpdatesAsync).mock.invocationCallOrder[0],
    );
    expect(BackgroundLocationWorker.getActiveTripId()).toBe('trip-live-001');

    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(true);
    await BackgroundLocationWorker.stopTracking();

    expect(clearPersistedActiveTripId).toHaveBeenCalledWith('trip-live-001');
    expect(BackgroundLocationWorker.getActiveTripId()).toBeNull();
  });

  it('restores persisted trip context for a fresh background task process', async () => {
    await expect(BackgroundLocationWorker.restoreActiveTrip()).resolves.toBe(
      'trip-persisted',
    );
    await expect(BackgroundLocationWorker.resolveActiveTripId()).resolves.toBe(
      'trip-persisted',
    );
    expect(BackgroundLocationWorker.getActiveTripId()).toBe('trip-persisted');
  });
});
