jest.mock('../../db/LocalDatabase', () => ({
  initDatabase: jest.fn(),
  getPendingQueueEntries: jest.fn(),
}));

jest.mock('../BackgroundLocationWorker', () => ({
  BackgroundLocationWorker: {
    startTracking: jest.fn(),
    restoreActiveTrip: jest.fn(),
    resolveActiveTripId: jest.fn(),
  },
}));

jest.mock('../StateCoordinator', () => ({
  StateCoordinator: {
    prepareRuntimeServices: jest.fn(),
    syncAllSystems: jest.fn(),
    startRuntimeServices: jest.fn(),
  },
}));

import {
  getPendingQueueEntries,
  initDatabase,
} from '../../db/LocalDatabase';
import { BackgroundLocationWorker } from '../BackgroundLocationWorker';
import { StateCoordinator } from '../StateCoordinator';
import {
  asyncInitializeApp,
  initializeAppWithCrashRecovery,
} from '../AppInitializer';

const mockGetPendingQueueEntries = jest.mocked(getPendingQueueEntries);
const mockInitDatabase = jest.mocked(initDatabase);
const mockBackgroundLocationWorker = jest.mocked(BackgroundLocationWorker);
const mockStateCoordinator = jest.mocked(StateCoordinator);

describe('AppInitializer – mobile runtime recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInitDatabase.mockResolvedValue({} as never);
    mockGetPendingQueueEntries.mockResolvedValue([]);
    mockBackgroundLocationWorker.startTracking.mockResolvedValue(undefined);
    mockBackgroundLocationWorker.restoreActiveTrip.mockResolvedValue(null);
    mockBackgroundLocationWorker.resolveActiveTripId.mockResolvedValue(null);
    mockStateCoordinator.prepareRuntimeServices.mockResolvedValue(undefined);
    mockStateCoordinator.syncAllSystems.mockResolvedValue(undefined);
    mockStateCoordinator.startRuntimeServices.mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('initializes SQLite before reading the outbox and starts runtime services', async () => {
    await initializeAppWithCrashRecovery();

    expect(mockInitDatabase).toHaveBeenCalledTimes(1);
    expect(mockGetPendingQueueEntries).toHaveBeenCalledTimes(1);
    expect(mockBackgroundLocationWorker.restoreActiveTrip).toHaveBeenCalledTimes(1);
    expect(mockStateCoordinator.prepareRuntimeServices).toHaveBeenCalledTimes(1);
    expect(mockStateCoordinator.syncAllSystems).not.toHaveBeenCalled();
    expect(mockStateCoordinator.startRuntimeServices).toHaveBeenCalledWith(null);
  });

  it('restores persisted trip tracking and runs recovery before starting daemons', async () => {
    mockBackgroundLocationWorker.restoreActiveTrip.mockResolvedValue('trip-recovered');
    mockGetPendingQueueEntries.mockResolvedValue([
      { order_id: 'trip-recovered' },
    ] as never);

    await initializeAppWithCrashRecovery();

    expect(mockStateCoordinator.syncAllSystems).toHaveBeenCalledWith('trip-recovered');
    expect(mockStateCoordinator.startRuntimeServices).toHaveBeenCalledWith('trip-recovered');
    expect(mockStateCoordinator.syncAllSystems.mock.invocationCallOrder[0]).toBeLessThan(
      mockStateCoordinator.startRuntimeServices.mock.invocationCallOrder[0],
    );
  });

  it('recovers the first pending outbox order when no active trip is saved', async () => {
    mockGetPendingQueueEntries.mockResolvedValue([
      { order_id: 'trip-pending-001' },
    ] as never);

    await initializeAppWithCrashRecovery();

    expect(mockStateCoordinator.syncAllSystems).toHaveBeenCalledWith('trip-pending-001');
    expect(mockStateCoordinator.startRuntimeServices).toHaveBeenCalledWith(null);
  });

  it('starts a trip provided by the mobile runtime', async () => {
    await initializeAppWithCrashRecovery(' trip-current ');

    expect(mockBackgroundLocationWorker.startTracking).toHaveBeenCalledWith('trip-current');
    expect(mockStateCoordinator.syncAllSystems).toHaveBeenCalledWith('trip-current');
    expect(mockStateCoordinator.startRuntimeServices).toHaveBeenCalledWith('trip-current');
  });

  it('continues outbox recovery when location tracking cannot be restored', async () => {
    mockBackgroundLocationWorker.restoreActiveTrip.mockRejectedValue(
      new Error('Location permission denied'),
    );
    mockBackgroundLocationWorker.resolveActiveTripId.mockResolvedValue('trip-persisted');
    mockGetPendingQueueEntries.mockResolvedValue([
      { order_id: 'trip-persisted' },
    ] as never);

    await expect(initializeAppWithCrashRecovery()).resolves.toBeUndefined();

    expect(mockStateCoordinator.syncAllSystems).toHaveBeenCalledWith('trip-persisted');
    expect(mockStateCoordinator.startRuntimeServices).toHaveBeenCalledWith('trip-persisted');
    expect(console.error).toHaveBeenCalledWith(
      '[AppInitializer] Location tracking recovery failed:',
      expect.any(Error),
    );
  });

  it('surfaces local database initialization and recovery failures', async () => {
    const error = new Error('Outbox unavailable');
    mockGetPendingQueueEntries.mockRejectedValue(error);

    await expect(initializeAppWithCrashRecovery()).rejects.toThrow(error);
    expect(mockStateCoordinator.startRuntimeServices).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '[AppInitializer] Fatal error during initialization:',
      error,
    );
  });

  it('retains the asyncInitializeApp compatibility wrapper', async () => {
    await asyncInitializeApp();

    expect(mockInitDatabase).toHaveBeenCalledTimes(1);
    expect(mockStateCoordinator.startRuntimeServices).toHaveBeenCalledWith(null);
  });
});
