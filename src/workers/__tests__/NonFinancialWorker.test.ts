import { EventEmitter } from 'node:events';

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisOn = jest.fn();
const mockRedisQuit = jest.fn();
const mockRedisDisconnect = jest.fn();
const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn();
let mockProcessor:
  | ((job: {
      id: string;
      name: string;
      data: Record<string, unknown>;
      attemptsMade: number;
    }) => Promise<void>)
  | undefined;
const mockRedisOptions: Array<Record<string, unknown>> = [];

jest.mock('ioredis', () =>
  jest.fn().mockImplementation((_url: string, options: Record<string, unknown>) => {
    mockRedisOptions.push(options);
    return {
      status: 'ready',
      get: mockRedisGet,
      set: mockRedisSet,
      on: mockRedisOn,
      quit: mockRedisQuit,
      disconnect: mockRedisDisconnect,
    };
  }),
);

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(
    (
      _queueName: string,
      processor: typeof mockProcessor,
      _options: Record<string, unknown>,
    ) => {
      mockProcessor = processor;
      return { on: mockWorkerOn, close: mockWorkerClose };
    },
  ),
}));

import { Worker } from 'bullmq';
import Redis from 'ioredis';
import {
  COMPLETED_BACKGROUND_JOB_TTL_SECONDS,
  DEFAULT_BACKGROUND_WORKER_CONCURRENCY,
  MAX_BACKGROUND_WORKER_CONCURRENCY,
  NonFinancialWorker,
  NonFinancialWorkerError,
  startNonFinancialWorker,
} from '../NonFinancialWorker';
import { SyncMetrics } from '../../services/SyncMetrics';

const REDIS_URL = 'redis://worker-user:private-password@redis.internal:6379';
const analyticsHandlers = {
  telemetry_aggregation: jest.fn<Promise<void>, [Record<string, unknown>, {
    jobId: string;
    idempotencyKey: string;
    attemptsMade: number;
  }]>().mockResolvedValue(undefined),
};

function createWorker(
  metrics: SyncMetrics | null = null,
  concurrency?: number,
): NonFinancialWorker {
  return new NonFinancialWorker('analytics', analyticsHandlers, {
    redisUrl: REDIS_URL,
    metrics,
    ...(concurrency === undefined ? {} : { concurrency }),
  });
}

function invokeProcessor(
  job: {
    id: string;
    name: string;
    data: Record<string, unknown>;
    attemptsMade: number;
  },
): Promise<void> {
  if (!mockProcessor) {
    throw new Error('Worker processor was not registered.');
  }
  return mockProcessor(job);
}

describe('NonFinancialWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisOptions.length = 0;
    mockProcessor = undefined;
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisQuit.mockResolvedValue('OK');
    mockWorkerClose.mockResolvedValue(undefined);
    analyticsHandlers.telemetry_aggregation.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts the requested queue worker with bounded default concurrency', () => {
    createWorker();

    expect(Worker).toHaveBeenCalledWith(
      'analytics',
      expect.any(Function),
      expect.objectContaining({
        concurrency: DEFAULT_BACKGROUND_WORKER_CONCURRENCY,
      }),
    );
    expect(Redis).toHaveBeenCalledWith(
      REDIS_URL,
      expect.objectContaining({ maxRetriesPerRequest: null }),
    );
  });

  it('rejects unsupported queues, missing handlers, and unbounded concurrency', () => {
    expect(
      () => new NonFinancialWorker('ledger' as never, {}, { redisUrl: REDIS_URL }),
    ).toThrow(NonFinancialWorkerError);
    expect(
      () =>
        new NonFinancialWorker('notifications', {}, { redisUrl: REDIS_URL }),
    ).toThrow(/handler is required/);
    expect(
      () => createWorker(null, MAX_BACKGROUND_WORKER_CONCURRENCY + 1),
    ).toThrow(/concurrency/);
    expect(Worker).not.toHaveBeenCalled();
  });

  it('processes a non-financial job with its stable idempotency key and records metrics', async () => {
    const metrics = new SyncMetrics();
    createWorker(metrics);
    const job = {
      id: 'analytics-opaque-job-id',
      name: 'telemetry_aggregation',
      data: { interval: 'hourly' },
      attemptsMade: 1,
    };

    await invokeProcessor(job);

    expect(analyticsHandlers.telemetry_aggregation).toHaveBeenCalledWith(job.data, {
      jobId: job.id,
      idempotencyKey: job.id,
      attemptsMade: 1,
    });
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^kona:background:completed:analytics:/),
      'completed',
      'EX',
      COMPLETED_BACKGROUND_JOB_TTL_SECONDS,
    );
    expect(metrics.snapshot().counters).toContainEqual({
      name: 'kona_sync_operations_total',
      labels: {
        operation: 'background_job',
        transport: 'none',
        outcome: 'success',
      },
      value: 1,
    });
    expect(metrics.snapshot().histograms[0].count).toBe(1);
  });

  it('skips duplicate completed jobs without re-running the handler', async () => {
    const metrics = new SyncMetrics();
    createWorker(metrics);
    mockRedisGet.mockResolvedValue('completed');

    await invokeProcessor({
      id: 'analytics-opaque-job-id',
      name: 'telemetry_aggregation',
      data: { interval: 'hourly' },
      attemptsMade: 2,
    });

    expect(analyticsHandlers.telemetry_aggregation).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(metrics.snapshot().counters[0]).toMatchObject({
      labels: { outcome: 'success' },
      value: 1,
    });
  });

  it('sanitizes handler failures while propagating them for BullMQ retry', async () => {
    const metrics = new SyncMetrics();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    analyticsHandlers.telemetry_aggregation.mockRejectedValueOnce(
      new Error('private credential must not leak'),
    );
    createWorker(metrics);

    await expect(
      invokeProcessor({
        id: 'private-job-id',
        name: 'telemetry_aggregation',
        data: { interval: 'hourly' },
        attemptsMade: 0,
      }),
    ).rejects.toMatchObject({
      name: 'NonFinancialWorkerError',
      message: 'Non-financial background job failed and may be retried.',
    });

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[NonFinancialWorker] Background job processing failed.',
    );
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('private credential'),
    );
    expect(metrics.snapshot().counters).toContainEqual({
      name: 'kona_sync_operations_total',
      labels: {
        operation: 'background_job',
        transport: 'none',
        outcome: 'failure',
      },
      value: 1,
    });
  });

  it('closes the worker and Redis connection once', async () => {
    const worker = createWorker();

    await Promise.all([worker.close(), worker.close()]);

    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
    expect(mockRedisDisconnect).not.toHaveBeenCalled();
    await expect(worker.close()).resolves.toBeUndefined();
  });

  it('handles SIGTERM with graceful worker and Redis shutdown', async () => {
    const signalSource = new EventEmitter();
    const worker = startNonFinancialWorker('analytics', analyticsHandlers, {
      redisUrl: REDIS_URL,
      metrics: null,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    await expect(worker.close()).resolves.toBeUndefined();
  });
});
