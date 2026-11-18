import express from 'express';
import request from 'supertest';
import base45 from 'base45';
import { createHash } from 'node:crypto';

const DRIVER_ID = '123e4567-e89b-42d3-a456-426614174000';
const TRIP_ID = '123e4567-e89b-42d3-a456-426614174001';
const SECRET = 'telemetry-test-secret';
const mockInsert = jest.fn();
const mockAssignment = jest.fn();
const mockBatchInsert = jest.fn();
const mockBatchReturning = jest.fn();
const mockExistingBatch = jest.fn();
const mockKnex = jest.fn((table: string) => {
  if (table === 'trips') {
    return {
      where: jest.fn().mockReturnThis(),
      first: mockAssignment,
    };
  }
  if (table === 'telemetry_ingestion_batches') {
    const query = {
      insert: mockBatchInsert,
      onConflict: jest.fn().mockReturnThis(),
      ignore: jest.fn().mockReturnThis(),
      returning: mockBatchReturning,
      where: jest.fn().mockReturnThis(),
      first: mockExistingBatch,
    };
    mockBatchInsert.mockReturnValue(query);
    return query;
  }
  return { insert: mockInsert };
});

jest.mock('../../database/knex', () => ({
  knex: Object.assign(mockKnex, {
    transaction: jest.fn(async (callback: (trx: typeof mockKnex) => Promise<unknown>) =>
      callback(mockKnex),
    ),
  }),
}));

jest.mock('../../repositories/DriverSecretRepository', () => ({
  DriverSecretRepository: {
    getSecretByDriverId: jest.fn(),
  },
}));

import telemetryRouter from '../telemetry';
import { DriverSecretRepository } from '../../repositories/DriverSecretRepository';
import { CryptoSignatureEngine } from '../../services/CryptoSignatureEngine';
import { telemetrySignaturePayload } from '../../utils/TelemetryAuth';

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use('/api/v1/telemetry', telemetryRouter);

function createBatch(): {
  trip_id: string;
  payload_b45: string;
  point_count: number;
  idempotency_key: string;
} {
  const timestamp = Date.now();
  return {
    trip_id: TRIP_ID,
    payload_b45: base45.encode(Buffer.from(`${TRIP_ID}|1.2,2.3,4.5,${timestamp}`)),
    point_count: 1,
    idempotency_key: 'a'.repeat(64),
  };
}

async function postBatch(body = createBatch()) {
  const signature = await CryptoSignatureEngine.generateStrongSignature(
    telemetrySignaturePayload(body),
    SECRET,
  );
  return request(app)
    .post('/api/v1/telemetry/batch')
    .set('x-kona-driver-id', DRIVER_ID)
    .set('x-kona-signature', signature)
    .send(body);
}

describe('POST /api/v1/telemetry/batch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssignment.mockResolvedValue({ order_id: TRIP_ID });
    mockInsert.mockResolvedValue(undefined);
    mockBatchReturning.mockResolvedValue([{ idempotency_key: 'batch-key' }]);
    jest.mocked(DriverSecretRepository.getSecretByDriverId).mockResolvedValue(SECRET);
  });

  it('authenticates the assigned driver and persists a bounded batch', async () => {
    const body = createBatch();
    const response = await postBatch(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', acceptedPoints: 1 });
    expect(mockAssignment).toHaveBeenCalledWith('order_id');
    expect(mockInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        trip_id: TRIP_ID,
        latitude: 1.2,
        longitude: 2.3,
        speed: 4.5,
      }),
    ]);
  });

  it('rejects missing credentials and does not write', async () => {
    const response = await request(app)
      .post('/api/v1/telemetry/batch')
      .send(createBatch());

    expect(response.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature', async () => {
    const response = await request(app)
      .post('/api/v1/telemetry/batch')
      .set('x-kona-driver-id', DRIVER_ID)
      .set('x-kona-signature', 'a'.repeat(64))
      .send(createBatch());

    expect(response.status).toBe(401);
    expect(mockAssignment).not.toHaveBeenCalled();
  });

  it('rejects a driver not assigned to the trip', async () => {
    mockAssignment.mockResolvedValue(undefined);

    const response = await postBatch();

    expect(response.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('accepts a matching duplicate idempotency key without inserting telemetry twice', async () => {
    const body = createBatch();
    const payloadHash = createHash('sha256').update(body.payload_b45).digest('hex');
    mockBatchReturning.mockResolvedValue([]);
    mockExistingBatch.mockResolvedValue({
      trip_id: TRIP_ID,
      driver_id: DRIVER_ID,
      payload_sha256: payloadHash,
      accepted_points: 1,
    });

    const response = await postBatch(body);

    expect(response.status).toBe(200);
    expect(response.body.acceptedPoints).toBe(1);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for different telemetry', async () => {
    mockBatchReturning.mockResolvedValue([]);
    mockExistingBatch.mockResolvedValue({
      trip_id: TRIP_ID,
      driver_id: DRIVER_ID,
      payload_sha256: '0'.repeat(64),
      accepted_points: 1,
    });

    expect((await postBatch()).status).toBe(409);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects out-of-range coordinates and malformed Base45 before persistence', async () => {
    const timestamp = Date.now();
    const makePointBatch = (point: string) => ({
      trip_id: TRIP_ID,
      payload_b45: base45.encode(Buffer.from(`${TRIP_ID}|${point}`)),
      point_count: 1,
      idempotency_key: 'a'.repeat(64),
    });
    expect((await postBatch(makePointBatch(`91,2.3,,${timestamp}`))).status).toBe(400);
    expect((await postBatch(makePointBatch(`1,2.3,101,${timestamp}`))).status).toBe(400);
    expect(
      (await postBatch(makePointBatch(`1,2.3,,${Date.UTC(1999, 0, 1)}`))).status,
    ).toBe(400);
    expect((await postBatch(makePointBatch(`1,2.3,,${timestamp + 6 * 60 * 1000}`))).status).toBe(
      400,
    );

    const malformedBase45 = {
      trip_id: TRIP_ID,
      payload_b45: 'bad=base45',
      point_count: 1,
      idempotency_key: 'a'.repeat(64),
    };
    expect((await postBatch(malformedBase45)).status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('enforces point-count and encoded payload limits', async () => {
    expect(
      (
        await postBatch({
          trip_id: TRIP_ID,
          payload_b45: base45.encode(Buffer.from(`${TRIP_ID}|1,2,,${Date.now()}`)),
          point_count: 11,
          idempotency_key: 'a'.repeat(64),
        })
      ).status,
    ).toBe(400);

    const oversized = {
      trip_id: TRIP_ID,
      payload_b45: 'A'.repeat(17_000),
      point_count: 1,
      idempotency_key: 'a'.repeat(64),
    };
    expect((await postBatch(oversized)).status).toBe(413);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns retryable HTTP 500 when the database write fails', async () => {
    mockInsert.mockRejectedValue(new Error('database unavailable'));

    const response = await postBatch();

    expect(response.status).toBe(500);
    expect(response.body.status).toBe('error');
  });
});
