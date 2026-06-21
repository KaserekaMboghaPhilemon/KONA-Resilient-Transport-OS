/**
 * Sprint 8.5 – SyncController Lifecycle Binding Tests
 *
 * Verifies that the SyncController correctly routes trip lifecycle events
 * to the BackgroundLocationWorker for native GPS tracking management.
 *
 * Test Coverage:
 * 1. START_RIDE triggers BackgroundLocationWorker.startTracking()
 * 2. END_RIDE triggers BackgroundLocationWorker.stopTracking()
 * 3. Error handling: tracking failures do not abort the action
 * 4. Idempotency enforcement
 * 5. Payload validation
 */

// Mock dependencies before importing the module under test
// knex must be mocked first: all three repositories import it at module level,
// and jest.mock without a factory still loads the real module to build the
// automock. Without this stub the real pg connection pool is created, keeping
// the Node.js event loop alive after the suite and causing Jest to hang.
jest.mock('../../database/knex', () => ({
  knex: Object.assign(jest.fn().mockReturnValue({ where: jest.fn(), insert: jest.fn(), update: jest.fn(), select: jest.fn() }), {
    transaction: jest.fn(),
  }),
}));
jest.mock('../../repositories/IdempotencyRepository');
jest.mock('../../repositories/TripRepository');
jest.mock('../../repositories/DriverSecretRepository');
jest.mock('../../services/BackgroundLocationWorker');

import { SyncController } from '../SyncController';
import { IdempotencyRepository } from '../../repositories/IdempotencyRepository';
import { TripRepository } from '../../repositories/TripRepository';
import { DriverSecretRepository } from '../../repositories/DriverSecretRepository';
import { BackgroundLocationWorker } from '../../services/BackgroundLocationWorker';
import { CryptoSignatureEngine } from '../../services/CryptoSignatureEngine';

const mockIdempotencyRepository = IdempotencyRepository as jest.Mocked<typeof IdempotencyRepository>;
const mockTripRepository = TripRepository as jest.Mocked<typeof TripRepository>;
const mockDriverSecretRepository = DriverSecretRepository as jest.Mocked<typeof DriverSecretRepository>;
const mockBackgroundLocationWorker = BackgroundLocationWorker as jest.Mocked<typeof BackgroundLocationWorker>;

describe('SyncController – Sprint 8.5 Lifecycle Binding Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIdempotencyRepository.checkAndRegisterKey.mockResolvedValue(false);
    mockIdempotencyRepository.releaseKey.mockResolvedValue(undefined);
    mockDriverSecretRepository.getSecretByDriverId.mockResolvedValue('TEST_DRIVER_SECRET');
  });

  describe('Sprint 11.5 signature authentication gate', () => {
    it('rejects execution when incoming signature does not match expected HMAC', async () => {
      mockTripRepository.createTripRecord.mockResolvedValue(undefined);

      const rawWire = 'WIRE_PAYLOAD_FOR_HMAC';
      const badSignature = 'DEADBEEF';

      const action = {
        idempotency_key: 'idem-auth-001',
        action_type: 'CREATE_TRIP' as const,
        payload: {
          order_id: 'trip-auth-1',
          driver_id: 'driver-xyz',
        },
        __kona_raw_wire: rawWire,
        __kona_signature_hex: badSignature,
      };

      await expect(SyncController.executeAction(action)).rejects.toThrow(
        /Signature verification failed/i,
      );
      expect(mockTripRepository.createTripRecord).not.toHaveBeenCalled();
    });

    it('allows execution when signature matches expected HMAC', async () => {
      mockTripRepository.createTripRecord.mockResolvedValue(undefined);

      const rawWire = 'WIRE_PAYLOAD_FOR_HMAC_OK';
      const validSignature = await CryptoSignatureEngine.generateSignature(
        rawWire,
        'TEST_DRIVER_SECRET',
      );

      const action = {
        idempotency_key: 'idem-auth-002',
        action_type: 'CREATE_TRIP' as const,
        payload: {
          order_id: 'trip-auth-2',
          driver_id: 'driver-xyz',
        },
        __kona_raw_wire: rawWire,
        __kona_signature_hex: validSignature,
      };

      await expect(SyncController.executeAction(action)).resolves.not.toThrow();
      expect(mockTripRepository.createTripRecord).toHaveBeenCalledTimes(1);
    });
  });

  describe('START_RIDE action – background location tracking', () => {
    it('should call BackgroundLocationWorker.startTracking with tripId after successful trip status update', async () => {
      mockTripRepository.updateTripStatus.mockResolvedValue(undefined);
      mockBackgroundLocationWorker.startTracking.mockResolvedValue(undefined);

      const action = {
        idempotency_key: 'idem-start-001',
        action_type: 'START_RIDE' as const,
        payload: {
          order_id: 'trip-123',
          driver_id: 'driver-xyz',
        },
      };

      await SyncController.executeAction(action);

      // Verify trip status was updated to ACTIVE
      expect(mockTripRepository.updateTripStatus).toHaveBeenCalledWith('trip-123', 'ACTIVE');

      // Verify background tracking was started with the trip ID
      expect(mockBackgroundLocationWorker.startTracking).toHaveBeenCalledWith('trip-123');
    });

    it('should proceed with action even if BackgroundLocationWorker.startTracking fails', async () => {
      mockTripRepository.updateTripStatus.mockResolvedValue(undefined);
      mockBackgroundLocationWorker.startTracking.mockRejectedValue(
        new Error('Location permissions denied'),
      );

      const action = {
        idempotency_key: 'idem-start-002',
        action_type: 'START_RIDE' as const,
        payload: {
          order_id: 'trip-456',
          driver_id: 'driver-abc',
        },
      };

      // Should NOT throw — action succeeds despite tracking init failure
      await expect(SyncController.executeAction(action)).resolves.not.toThrow();

      // Trip status should still be updated
      expect(mockTripRepository.updateTripStatus).toHaveBeenCalledWith('trip-456', 'ACTIVE');

      // Tracking was attempted but failed gracefully
      expect(mockBackgroundLocationWorker.startTracking).toHaveBeenCalledWith('trip-456');
    });

    it('should extract tripId from trip_id field when order_id is not present', async () => {
      mockTripRepository.updateTripStatus.mockResolvedValue(undefined);
      mockBackgroundLocationWorker.startTracking.mockResolvedValue(undefined);

      const action = {
        idempotency_key: 'idem-start-003',
        action_type: 'START_RIDE' as const,
        payload: {
          trip_id: 'trip-789',
          driver_id: 'driver-def',
        },
      };

      await SyncController.executeAction(action);

      expect(mockTripRepository.updateTripStatus).toHaveBeenCalledWith('trip-789', 'ACTIVE');
      expect(mockBackgroundLocationWorker.startTracking).toHaveBeenCalledWith('trip-789');
    });
  });

  describe('END_RIDE action – stop background location tracking', () => {
    it('should call BackgroundLocationWorker.stopTracking before finalizing trip', async () => {
      mockBackgroundLocationWorker.stopTracking.mockResolvedValue(undefined);
      mockTripRepository.terminateTripLifecycle.mockResolvedValue(undefined);

      const action = {
        idempotency_key: 'idem-end-001',
        action_type: 'END_RIDE' as const,
        payload: {
          order_id: 'trip-123',
          driver_id: 'driver-xyz',
          final_fare: 25.5,
        },
      };

      await SyncController.executeAction(action);

      // Verify stopTracking was called
      expect(mockBackgroundLocationWorker.stopTracking).toHaveBeenCalled();

      // Verify trip lifecycle was finalized after stopping tracking
      expect(mockTripRepository.terminateTripLifecycle).toHaveBeenCalledWith(
        'trip-123',
        expect.objectContaining({
          order_id: 'trip-123',
          driver_id: 'driver-xyz',
          final_fare: 25.5,
        }),
      );
    });

    it('should proceed with trip finalization even if BackgroundLocationWorker.stopTracking fails', async () => {
      mockBackgroundLocationWorker.stopTracking.mockRejectedValue(
        new Error('Task not active'),
      );
      mockTripRepository.terminateTripLifecycle.mockResolvedValue(undefined);

      const action = {
        idempotency_key: 'idem-end-002',
        action_type: 'END_RIDE' as const,
        payload: {
          order_id: 'trip-456',
          driver_id: 'driver-abc',
          final_fare: 18.75,
        },
      };

      // Should NOT throw — action succeeds despite tracking stop failure
      await expect(SyncController.executeAction(action)).resolves.not.toThrow();

      // Trip should still be finalized
      expect(mockTripRepository.terminateTripLifecycle).toHaveBeenCalledWith(
        'trip-456',
        expect.any(Object),
      );
    });

    it('should extract tripId from trip_id field when order_id is not present', async () => {
      mockBackgroundLocationWorker.stopTracking.mockResolvedValue(undefined);
      mockTripRepository.terminateTripLifecycle.mockResolvedValue(undefined);

      const action = {
        idempotency_key: 'idem-end-003',
        action_type: 'END_RIDE' as const,
        payload: {
          trip_id: 'trip-789',
          driver_id: 'driver-def',
          final_fare: 32.0,
        },
      };

      await SyncController.executeAction(action);

      expect(mockTripRepository.terminateTripLifecycle).toHaveBeenCalledWith(
        'trip-789',
        expect.any(Object),
      );
    });
  });

  describe('Idempotency enforcement', () => {
    it('should skip processing and return early if idempotency key is already registered', async () => {
      mockIdempotencyRepository.checkAndRegisterKey.mockResolvedValue(true); // Duplicate

      const action = {
        idempotency_key: 'idem-duplicate',
        action_type: 'START_RIDE' as const,
        payload: {
          order_id: 'trip-123',
          driver_id: 'driver-xyz',
        },
      };

      await SyncController.executeAction(action);

      // Should not attempt any repository operations
      expect(mockTripRepository.updateTripStatus).not.toHaveBeenCalled();
      expect(mockBackgroundLocationWorker.startTracking).not.toHaveBeenCalled();
    });
  });

  describe('Payload validation', () => {
    it('should throw TypeError if action is not an object', async () => {
      await expect(SyncController.executeAction('not an object')).rejects.toThrow(
        TypeError,
      );
    });

    it('should throw TypeError if idempotency_key is missing', async () => {
      const action = {
        action_type: 'START_RIDE' as const,
        payload: { order_id: 'trip-123' },
      };

      await expect(SyncController.executeAction(action)).rejects.toThrow(
        /idempotency_key/i,
      );
    });

    it('should throw TypeError if payload is missing', async () => {
      const action = {
        idempotency_key: 'idem-test',
        action_type: 'START_RIDE' as const,
      };

      await expect(SyncController.executeAction(action)).rejects.toThrow(
        /payload/i,
      );
    });

    it('should throw TypeError if START_RIDE payload lacks tripId', async () => {
      mockIdempotencyRepository.checkAndRegisterKey.mockResolvedValue(false);

      const action = {
        idempotency_key: 'idem-no-trip',
        action_type: 'START_RIDE' as const,
        payload: {
          driver_id: 'driver-xyz',
          // Missing order_id and trip_id
        },
      };

      await expect(SyncController.executeAction(action)).rejects.toThrow(
        /START_RIDE requires/i,
      );
    });
  });

  describe('Other action types – regression verification', () => {
    it('CREATE_TRIP should not trigger tracking', async () => {
      mockTripRepository.createTripRecord.mockResolvedValue(undefined);

      const action = {
        idempotency_key: 'idem-create',
        action_type: 'CREATE_TRIP' as const,
        payload: {
          order_id: 'trip-new',
          driver_id: 'driver-xyz',
          origin: { lat: 0, lon: 0 },
          destination: { lat: 1, lon: 1 },
        },
      };

      await SyncController.executeAction(action);

      expect(mockTripRepository.createTripRecord).toHaveBeenCalled();
      expect(mockBackgroundLocationWorker.startTracking).not.toHaveBeenCalled();
    });

    it('UPDATE_FARE should not trigger tracking', async () => {
      mockTripRepository.updateTripFare.mockResolvedValue(undefined);

      const action = {
        idempotency_key: 'idem-fare',
        action_type: 'UPDATE_FARE' as const,
        payload: {
          order_id: 'trip-123',
          final_fare: 50.0,
        },
      };

      await SyncController.executeAction(action);

      expect(mockTripRepository.updateTripFare).toHaveBeenCalled();
      expect(mockBackgroundLocationWorker.startTracking).not.toHaveBeenCalled();
      expect(mockBackgroundLocationWorker.stopTracking).not.toHaveBeenCalled();
    });
  });

  describe('Idempotency key cleanup on error', () => {
    it('should release idempotency key if action handler throws', async () => {
      mockIdempotencyRepository.checkAndRegisterKey.mockResolvedValue(false);
      mockTripRepository.updateTripStatus.mockRejectedValue(
        new Error('Database connection failed'),
      );

      const action = {
        idempotency_key: 'idem-error',
        action_type: 'START_RIDE' as const,
        payload: {
          order_id: 'trip-123',
          driver_id: 'driver-xyz',
        },
      };

      await expect(SyncController.executeAction(action)).rejects.toThrow();

      // Idempotency key should be released so the action can be retried
      expect(mockIdempotencyRepository.releaseKey).toHaveBeenCalledWith('idem-error');
    });
  });
});
