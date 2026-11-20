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
  knex: Object.assign(jest.fn(), {
    transaction: jest.fn(
      async (callback: (trx: object) => Promise<unknown>) => callback({}),
    ),
  }),
}));
jest.mock('../../repositories/IdempotencyRepository');
jest.mock('../../repositories/TripRepository');
jest.mock('../../repositories/OfflineLedgerRepository');
jest.mock('../../repositories/DriverSecretRepository');
jest.mock('../../services/BackgroundLocationWorker', () => ({
  BackgroundLocationWorker: {
    startTracking: jest.fn(),
    stopTracking: jest.fn(),
  },
}));

import { SyncController } from '../SyncController';
import { IdempotencyRepository } from '../../repositories/IdempotencyRepository';
import { TripRepository } from '../../repositories/TripRepository';
import { OfflineLedgerRepository } from '../../repositories/OfflineLedgerRepository';
import { DriverSecretRepository } from '../../repositories/DriverSecretRepository';
import { BackgroundLocationWorker } from '../../services/BackgroundLocationWorker';
import { CryptoSignatureEngine } from '../../services/CryptoSignatureEngine';
import { ServerLedgerReconciler } from '../../services/ServerLedgerReconciler';

const mockIdempotencyRepository = IdempotencyRepository as jest.Mocked<typeof IdempotencyRepository>;
const mockTripRepository = TripRepository as jest.Mocked<typeof TripRepository>;
const mockOfflineLedgerRepository = OfflineLedgerRepository as jest.Mocked<typeof OfflineLedgerRepository>;
const mockDriverSecretRepository = DriverSecretRepository as jest.Mocked<typeof DriverSecretRepository>;
const mockBackgroundLocationWorker = BackgroundLocationWorker as jest.Mocked<typeof BackgroundLocationWorker>;

describe('SyncController – Sprint 8.5 Lifecycle Binding Tests', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockIdempotencyRepository.checkAndRegisterKey.mockResolvedValue(false);
    mockIdempotencyRepository.releaseKey.mockResolvedValue(undefined);
    mockDriverSecretRepository.getSecretByDriverId.mockResolvedValue('TEST_DRIVER_SECRET');
    mockDriverSecretRepository.getAuthenticationByPhone.mockResolvedValue({
      driver_id: 'driver-xyz',
      secret_key: 'TEST_DRIVER_SECRET',
    });
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
      expect(mockTripRepository.updateTripStatus).toHaveBeenCalledWith(
        'trip-123',
        'ACTIVE',
        expect.anything(),
      );

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
      expect(mockTripRepository.updateTripStatus).toHaveBeenCalledWith(
        'trip-456',
        'ACTIVE',
        expect.anything(),
      );

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

      expect(mockTripRepository.updateTripStatus).toHaveBeenCalledWith(
        'trip-789',
        'ACTIVE',
        expect.anything(),
      );
      expect(mockBackgroundLocationWorker.startTracking).toHaveBeenCalledWith('trip-789');
    });
  });

  describe('END_RIDE action – stop background location tracking', () => {
    it('should stop background tracking after finalizing the trip transaction', async () => {
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
        expect.anything(),
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
        expect.anything(),
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
        expect.anything(),
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

    describe('SMS authentication and offline-ledger dispatch', () => {
      it('rejects unsigned direct HTTP ledger actions', async () => {
        await expect(
          SyncController.executeAction({
            idempotency_key: 'unsigned-ledger-action',
            action_type: 'DRIVER_LOCATION_UPDATE',
            payload: {
              order_id: 'trip-1',
              driver_id: 'driver-xyz',
              h3_cell: '8928308280fffff',
            },
          }),
        ).rejects.toThrow(/signed action envelope/i);

        expect(mockOfflineLedgerRepository.apply).not.toHaveBeenCalled();
      });

      it('authenticates the gateway sender, restores the driver identity, and dispatches a ledger action', async () => {
        const rawWire = 'BASE45_CANONICAL_JSON';
        const signature = await CryptoSignatureEngine.generateSignature(
          rawWire,
          'TEST_DRIVER_SECRET',
        );
        mockOfflineLedgerRepository.apply.mockResolvedValue(undefined);

        await SyncController.executeAction({
          idempotency_key: 'sms-idem-1',
          action_type: 'DRIVER_LOCATION_UPDATE',
          payload: { order_id: 'trip-1', h3_cell: '8928308280fffff' },
          __kona_signature_hex: signature,
          __kona_raw_wire: rawWire,
          __kona_sender: '+254700000001',
        });

        expect(mockDriverSecretRepository.getAuthenticationByPhone)
          .toHaveBeenCalledWith('+254700000001');
        expect(mockOfflineLedgerRepository.apply).toHaveBeenCalledWith(
          'DRIVER_LOCATION_UPDATE',
          'trip-1',
          'driver-xyz',
          expect.objectContaining({ h3_cell: '8928308280fffff' }),
          expect.anything(),
        );
      });
    });

    describe('verified batch transaction execution', () => {
      it('executes reconciled rows in verified order on one transaction handle', async () => {
        const createAction = {
          idempotency_key: 'batch-create',
          action_type: 'CREATE_TRIP',
          payload: { order_id: 'trip-batch', driver_id: 'driver-xyz' },
        };
        const startAction = {
          idempotency_key: 'batch-start',
          action_type: 'START_RIDE',
          payload: { order_id: 'trip-batch', driver_id: 'driver-xyz' },
        };
        const orderedRows = [
          {
            id: 1,
            payload: JSON.stringify(createAction),
            previous_row_hash: 'GENESIS',
            row_signature: 'SIG-1',
          },
          {
            id: 2,
            payload: JSON.stringify(startAction),
            previous_row_hash: 'SIG-1',
            row_signature: 'SIG-2',
          },
        ];

        jest.spyOn(ServerLedgerReconciler, 'verifyBatchSignature').mockReturnValue(true);
        jest.spyOn(ServerLedgerReconciler, 'verifyIncomingChain').mockResolvedValue({
          success: true,
          orderedRows,
        });

        const result = await SyncController.ingestOfflineLedgerBatch({
          driverId: 'driver-xyz',
          deviceId: 'device-xyz',
          rows: [...orderedRows].reverse(),
          batchSignatureHex: 'signature',
          lastValidServerHash: null,
        });

        expect(result).toEqual({ success: true, acceptedRows: 2 });
        expect(mockIdempotencyRepository.checkAndRegisterKey.mock.calls.map(([key]) => key))
          .toEqual(['batch-create', 'batch-start']);

        const trx = mockIdempotencyRepository.checkAndRegisterKey.mock.calls[0][1];
        expect(mockIdempotencyRepository.checkAndRegisterKey.mock.calls[1][1]).toBe(trx);
        expect(mockTripRepository.createTripRecord).toHaveBeenCalledWith(
          createAction.payload,
          trx,
        );
        expect(mockTripRepository.updateTripStatus).toHaveBeenCalledWith(
          'trip-batch',
          'ACTIVE',
          trx,
        );
      });
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

  describe('Idempotency rollback on error', () => {
    it('should rely on transaction rollback rather than manually releasing the key', async () => {
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
      expect(mockIdempotencyRepository.releaseKey).not.toHaveBeenCalled();
      const trx = mockIdempotencyRepository.checkAndRegisterKey.mock.calls[0][1];
      expect(mockTripRepository.updateTripStatus).toHaveBeenCalledWith(
        'trip-123',
        'ACTIVE',
        trx,
      );
    });
  });
});
