/**
 * Sprint 8.5 – AppInitializer Crash Recovery Tests
 *
 * Tests the app initialization logic that detects and recovers from
 * uncompleted trips after device crash/reboot scenarios.
 */

// Mock dependencies before importing the module under test
jest.mock('../../repositories/TripRepository', () => ({
  TripRepository: {
    getActiveTripIds: jest.fn(),
  },
}));
jest.mock('../BackgroundLocationWorker', () => ({
  BackgroundLocationWorker: {
    startTracking: jest.fn(),
    stopTracking: jest.fn(),
  },
}));

import {
  initializeAppWithCrashRecovery,
  asyncInitializeApp,
} from '../AppInitializer';

const { TripRepository } = jest.requireMock('../../repositories/TripRepository') as {
  TripRepository: {
    getActiveTripIds: jest.Mock;
  };
};

const { BackgroundLocationWorker } = jest.requireMock('../BackgroundLocationWorker') as {
  BackgroundLocationWorker: {
    startTracking: jest.Mock;
    stopTracking: jest.Mock;
  };
};

const mockTripRepository = TripRepository;
const mockBackgroundLocationWorker = BackgroundLocationWorker;

describe('AppInitializer – Crash Recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('initializeAppWithCrashRecovery()', () => {
    it('should log clean state when no active trips exist', async () => {
      mockTripRepository.getActiveTripIds.mockResolvedValue([]);

      await initializeAppWithCrashRecovery();

      expect(mockTripRepository.getActiveTripIds).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No active trips found'),
      );
    });

    it('should start tracking for each active trip found', async () => {
      mockTripRepository.getActiveTripIds.mockResolvedValue([
        'trip-001',
        'trip-002',
        'trip-003',
      ]);
      mockBackgroundLocationWorker.startTracking.mockResolvedValue(undefined);

      await initializeAppWithCrashRecovery();

      expect(mockBackgroundLocationWorker.startTracking).toHaveBeenCalledTimes(3);
      expect(mockBackgroundLocationWorker.startTracking).toHaveBeenCalledWith('trip-001');
      expect(mockBackgroundLocationWorker.startTracking).toHaveBeenCalledWith('trip-002');
      expect(mockBackgroundLocationWorker.startTracking).toHaveBeenCalledWith('trip-003');
    });

    it('should log warning when active trips are detected', async () => {
      mockTripRepository.getActiveTripIds.mockResolvedValue(['trip-001', 'trip-002']);
      mockBackgroundLocationWorker.startTracking.mockResolvedValue(undefined);

      await initializeAppWithCrashRecovery();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Detected 2 active trip(s)'),
      );
    });

    it('should continue recovery even if one trip fails to restore tracking', async () => {
      mockTripRepository.getActiveTripIds.mockResolvedValue([
        'trip-001',
        'trip-002',
        'trip-003',
      ]);
      mockBackgroundLocationWorker.startTracking
        .mockResolvedValueOnce(undefined) // trip-001 succeeds
        .mockRejectedValueOnce(new Error('Permissions denied')) // trip-002 fails
        .mockResolvedValueOnce(undefined); // trip-003 succeeds

      // Should NOT throw
      await expect(initializeAppWithCrashRecovery()).resolves.not.toThrow();

      // All three trips should have been attempted
      expect(mockBackgroundLocationWorker.startTracking).toHaveBeenCalledTimes(3);

      // Error should be logged but not fatal
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to restore tracking for trip trip-002'),
        expect.any(Error),
      );
    });

    it('should log success message after recovery completes', async () => {
      mockTripRepository.getActiveTripIds.mockResolvedValue(['trip-001']);
      mockBackgroundLocationWorker.startTracking.mockResolvedValue(undefined);

      await initializeAppWithCrashRecovery();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Crash recovery completed'),
      );
    });

    it('should re-throw if TripRepository query itself fails', async () => {
      const error = new Error('Database unavailable');
      mockTripRepository.getActiveTripIds.mockRejectedValue(error);

      await expect(initializeAppWithCrashRecovery()).rejects.toThrow(error);

      expect(console.error).toHaveBeenCalledWith(
        '[AppInitializer] Fatal error during initialization:',
        error,
      );
    });

    it('should be idempotent – calling multiple times is safe', async () => {
      mockTripRepository.getActiveTripIds.mockResolvedValue([]);

      await initializeAppWithCrashRecovery();
      await initializeAppWithCrashRecovery();

      // Should not error or have side effects
      expect(mockTripRepository.getActiveTripIds).toHaveBeenCalledTimes(2);
    });
  });

  describe('asyncInitializeApp()', () => {
    it('should be a thin wrapper around initializeAppWithCrashRecovery()', async () => {
      mockTripRepository.getActiveTripIds.mockResolvedValue([]);

      await asyncInitializeApp();

      expect(mockTripRepository.getActiveTripIds).toHaveBeenCalled();
    });
  });

  describe('Operational Logging', () => {
    it('should log trip-specific recovery messages for visibility', async () => {
      mockTripRepository.getActiveTripIds.mockResolvedValue(['trip-abc-123']);
      mockBackgroundLocationWorker.startTracking.mockResolvedValue(undefined);

      await initializeAppWithCrashRecovery();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Restoring background location tracking for trip: trip-abc-123'),
      );
    });
  });
});
