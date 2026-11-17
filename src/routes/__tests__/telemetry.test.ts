import express from 'express';
import request from 'supertest';
import base45 from 'base45';

jest.mock('../../database/knex', () => {
  const insert = jest.fn().mockResolvedValue(2);
  return {
    knex: Object.assign(jest.fn(() => ({ insert })), { insertQuery: insert }),
  };
});

import telemetryRouter from '../telemetry';
import { knex } from '../../database/knex';
const mockInsert = (knex as typeof knex & { insertQuery: jest.Mock }).insertQuery;

describe('POST /api/v1/telemetry/batch', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/telemetry', telemetryRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    mockInsert.mockClear();
  });

  it('decodes and persists a valid telemetry batch', async () => {
    const body = {
      trip_id: 'trip-1',
      payload_b45: base45.encode(Buffer.from('trip-1|1.2,2.3,4.5,1700000000000;2.2,3.3,,1700000001000')),
      point_count: 2,
    };

    const response = await request(app).post('/api/v1/telemetry/batch').send(body);

    expect(response.status).toBe(200);
    expect(response.body.acceptedPoints).toBe(2);
    expect(knex).toHaveBeenCalledWith('trip_telemetry_points');
    expect(mockInsert).toHaveBeenCalledWith([
      {
        trip_id: 'trip-1',
        latitude: 1.2,
        longitude: 2.3,
        speed: 4.5,
        timestamp: 1700000000000,
      },
      {
        trip_id: 'trip-1',
        latitude: 2.2,
        longitude: 3.3,
        speed: null,
        timestamp: 1700000001000,
      },
    ]);
  });

  it('rejects point-count mismatches without writing', async () => {
    const response = await request(app)
      .post('/api/v1/telemetry/batch')
      .send({
        trip_id: 'trip-1',
        payload_b45: base45.encode(Buffer.from('trip-1|1.2,2.3,,1700000000000')),
        point_count: 2,
      });

    expect(response.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
