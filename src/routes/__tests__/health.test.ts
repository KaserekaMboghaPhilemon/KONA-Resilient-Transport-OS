import express from 'express';
import request from 'supertest';
import { app as serverApp } from '../../index';
import { SyncMetrics } from '../../services/SyncMetrics';
import { createHealthRouter, type HealthDependencies } from '../health';

function createApp(
  dependencies: HealthDependencies,
  metrics = new SyncMetrics(),
): express.Express {
  const app = express();
  app.use(createHealthRouter(dependencies, metrics));
  return app;
}

describe('health and metrics routes', () => {
  it('reports liveness without checking dependencies', async () => {
    const dependencies: HealthDependencies = {
      postgres: jest.fn().mockRejectedValue(new Error('database unavailable')),
      redis: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const app = createApp(dependencies);

    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'alive' });
    expect(dependencies.postgres).not.toHaveBeenCalled();
    expect(dependencies.redis).not.toHaveBeenCalled();
  });

  it('reports ready when PostgreSQL and Redis checks succeed', async () => {
    const dependencies: HealthDependencies = {
      postgres: jest.fn().mockResolvedValue(undefined),
      redis: jest.fn().mockResolvedValue(undefined),
    };

    const response = await request(createApp(dependencies)).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ready',
      dependencies: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('returns a sanitized degraded response when a dependency check fails', async () => {
    const secret = 'postgres://operator:very-secret@db.internal/kona';
    const dependencies: HealthDependencies = {
      postgres: jest.fn().mockRejectedValue(new Error(secret)),
      redis: jest.fn().mockResolvedValue(undefined),
    };

    const response = await request(createApp(dependencies)).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'degraded',
      dependencies: { postgres: 'unavailable', redis: 'ok' },
    });
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(JSON.stringify(response.body)).not.toContain('very-secret');
  });

  it('renders SyncMetrics as Prometheus text', async () => {
    const metrics = new SyncMetrics();
    metrics.incrementSyncOperations({
      operation: 'offline_sync',
      transport: 'http',
      outcome: 'success',
    });
    const app = createApp({
      postgres: jest.fn().mockResolvedValue(undefined),
      redis: jest.fn().mockResolvedValue(undefined),
    }, metrics);

    const response = await request(app).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain(
      'kona_sync_operations_total{operation="offline_sync",transport="http",outcome="success"} 1',
    );
  });

  it('preserves the existing root health response in the wired server app', async () => {
    const response = await request(serverApp).get('/');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'success',
      message: 'KONA Transport OS API is running',
    });
  });
});
