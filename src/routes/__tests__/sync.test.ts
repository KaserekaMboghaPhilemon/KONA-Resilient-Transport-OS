import express, { Application } from 'express';
import request from 'supertest';

jest.mock('../../controllers/SyncController', () => {
  class MockOfflineLedgerVerificationError extends Error {
    public readonly breachType: string;

    public readonly failedRowId?: number;

    constructor(breachType: string, failedRowId?: number) {
      super('mock breach');
      this.name = 'OfflineLedgerVerificationError';
      this.breachType = breachType;
      this.failedRowId = failedRowId;
    }
  }

  class MockSignatureAuthenticationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SignatureAuthenticationError';
    }
  }

  return {
    OfflineLedgerVerificationError: MockOfflineLedgerVerificationError,
    SignatureAuthenticationError: MockSignatureAuthenticationError,
    SyncController: {
      ingestOfflineLedgerBatch: jest.fn(),
    },
  };
});

import syncRouter from '../sync';
import {
  OfflineLedgerVerificationError,
  SyncController,
} from '../../controllers/SyncController';

const mockSyncController = SyncController as jest.Mocked<typeof SyncController>;

describe('POST /api/v1/sync/offline-batch', () => {
  const app: Application = express();
  app.use(express.json());
  app.use('/api/v1/sync', syncRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 200 on successful reconciliation', async () => {
    mockSyncController.ingestOfflineLedgerBatch.mockResolvedValue({
      success: true,
      acceptedRows: 2,
    });

    const res = await request(app)
      .post('/api/v1/sync/offline-batch')
      .send({
        driverId: 'driver-1',
        deviceId: 'device-1',
        rows: [],
        batchSignatureHex: '00',
        lastValidServerHash: null,
      });

    expect(res.status).toBe(200);
    expect(res.body.acceptedRows).toBe(2);
  });

  it('returns 400 with breach details when reconciliation fails', async () => {
    mockSyncController.ingestOfflineLedgerBatch.mockRejectedValue(
      new OfflineLedgerVerificationError('INVALID_SIGNATURE', 42),
    );

    const res = await request(app)
      .post('/api/v1/sync/offline-batch')
      .send({
        driverId: 'driver-2',
        deviceId: 'device-2',
        rows: [],
        batchSignatureHex: '00',
        lastValidServerHash: null,
      });

    expect(res.status).toBe(400);
    expect(res.body.breachType).toBe('INVALID_SIGNATURE');
    expect(res.body.failedRowId).toBe(42);
    expect(res.body.message).toContain('SUSPENDED_AUDIT');
  });
});
