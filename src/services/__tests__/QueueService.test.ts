const mockQueueAdd = jest.fn();
const mockQueueClose = jest.fn();
const mockQueueOn = jest.fn();
const mockRedisOn = jest.fn();
const mockRedisQuit = jest.fn();
const mockRedisDisconnect = jest.fn();
const mockRedisOptions: Array<Record<string, unknown>> = [];

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    close: mockQueueClose,
    on: mockQueueOn,
  })),
}));

jest.mock('ioredis', () =>
  jest.fn().mockImplementation((_url: string, options: Record<string, unknown>) => {
    mockRedisOptions.push(options);
    return {
      status: 'ready',
      on: mockRedisOn,
      quit: mockRedisQuit,
      disconnect: mockRedisDisconnect,
    };
  }),
);

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import {
  BACKGROUND_JOB_DEFAULT_OPTIONS,
  BACKGROUND_JOB_RETRY_POLICY,
  QueueService,
  QueueServiceError,
  createDeterministicJobId,
} from '../QueueService';
import { SyncMetrics } from '../SyncMetrics';

const REDIS_URL = 'redis://user:credential@redis.internal:6379';

function createService(metrics: SyncMetrics | null = null): QueueService {
  return new QueueService({ redisUrl: REDIS_URL, metrics });
}

describe('QueueService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisOptions.length = 0;
    mockQueueAdd.mockResolvedValue({ id: 'queued-job' });
    mockQueueClose.mockResolvedValue(undefined);
    mockRedisQuit.mockResolvedValue('OK');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers a queue once and uses bounded retry and retention defaults', () => {
    const service = createService();
    service.registerQueue('notifications');
    service.registerQueue('notifications');

    expect(Queue).toHaveBeenCalledTimes(1);
    expect(Queue).toHaveBeenCalledWith(
      'notifications',
      expect.objectContaining({
        defaultJobOptions: expect.objectContaining({
          attempts: BACKGROUND_JOB_RETRY_POLICY.attempts,
          backoff: {
            type: 'exponential',
            delay: BACKGROUND_JOB_RETRY_POLICY.backoffDelayMs,
          },
          removeOnComplete: BACKGROUND_JOB_DEFAULT_OPTIONS.removeOnComplete,
          removeOnFail: BACKGROUND_JOB_DEFAULT_OPTIONS.removeOnFail,
        }),
      }),
    );
  });

  it('uses deterministic opaque job IDs for idempotent enqueues', async () => {
    const service = createService();
    const idempotencyKey = 'notification-event-123';
    const expectedJobId = createDeterministicJobId(
      'notifications',
      'notification_delivery',
      idempotencyKey,
    );

    await service.enqueue('notifications', 'notification_delivery', idempotencyKey, {
      notificationId: 'notification-123',
    });
    await service.enqueue('notifications', 'notification_delivery', idempotencyKey, {
      notificationId: 'notification-123',
    });

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd).toHaveBeenNthCalledWith(
      1,
      'notification_delivery',
      { notificationId: 'notification-123' },
      { jobId: expectedJobId },
    );
    expect(mockQueueAdd.mock.calls[0][2].jobId).toBe(mockQueueAdd.mock.calls[1][2].jobId);
    expect(expectedJobId).not.toContain(idempotencyKey);
  });

  it('rejects unsupported financial queue or job names', async () => {
    const service = createService();

    expect(() => service.registerQueue('ledger' as never)).toThrow(QueueServiceError);
    await expect(
      service.enqueue(
        'analytics',
        'escrow_settlement' as never,
        'event-1',
        { amountMinor: 100 },
      ),
    ).rejects.toThrow(QueueServiceError);
    expect(Queue).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('records success, duration, and sanitized failures through SyncMetrics', async () => {
    const metrics = new SyncMetrics();
    const service = createService(metrics);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const secretError = new Error(
      'redis://operator:do-not-log@redis.internal plus private payload',
    );

    mockQueueAdd.mockRejectedValueOnce(secretError);
    await expect(
      service.enqueue('analytics', 'telemetry_aggregation', 'sensitive-idempotency-key', {
        period: 'hourly',
      }),
    ).rejects.toMatchObject({
      name: 'QueueServiceError',
      message: 'Unable to enqueue background job.',
    });

    mockQueueAdd.mockResolvedValueOnce({ id: 'safe-job-id' });
    await service.enqueue('analytics', 'telemetry_aggregation', 'another-key', {
      period: 'hourly',
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.counters).toContainEqual({
      name: 'kona_sync_operations_total',
      labels: {
        operation: 'background_job',
        transport: 'none',
        outcome: 'failure',
      },
      value: 1,
    });
    expect(snapshot.counters).toContainEqual({
      name: 'kona_sync_operations_total',
      labels: {
        operation: 'background_job',
        transport: 'none',
        outcome: 'success',
      },
      value: 1,
    });
    expect(snapshot.histograms).toHaveLength(1);
    expect(snapshot.histograms[0].count).toBe(2);
    expect(consoleError).toHaveBeenCalledWith(
      '[QueueService] Background job enqueue failed.',
    );
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('do-not-log'));
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('sensitive-idempotency-key'),
    );

    consoleError.mockRestore();
    await service.close();
  });

  it('closes registered queues and the shared Redis connection once', async () => {
    const service = createService();
    service.registerQueue('notifications');
    service.registerQueue('maintenance');

    await Promise.all([service.close(), service.close()]);

    expect(mockQueueClose).toHaveBeenCalledTimes(2);
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
    expect(mockRedisDisconnect).not.toHaveBeenCalled();
    await expect(service.close()).resolves.toBeUndefined();
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
    expect(() =>
      service.registerQueue('notifications'),
    ).toThrow('Queue service is closed.');
  });

  it('still closes Redis and reports a sanitized error when a queue close fails', async () => {
    const service = createService();
    service.registerQueue('notifications');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockQueueClose.mockRejectedValueOnce(
      new Error('redis://operator:do-not-log@redis.internal'),
    );

    await expect(service.close()).rejects.toMatchObject({
      name: 'QueueServiceError',
      message: 'Unable to close background queue resources.',
    });

    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[QueueService] Background queue shutdown failed.',
    );
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('do-not-log'),
    );
  });

  it('uses a bounded Redis retry delay and sanitized connection errors', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const metrics = new SyncMetrics();
    createService(metrics);

    expect(Redis).toHaveBeenCalledWith(
      REDIS_URL,
      expect.objectContaining({
        maxRetriesPerRequest: null,
        retryStrategy: expect.any(Function),
      }),
    );
    const retryStrategy = mockRedisOptions[0].retryStrategy as (
      attempt: number,
    ) => number;
    expect(retryStrategy(1)).toBe(250);
    expect(retryStrategy(100)).toBe(5_000);

    const redisErrorHandler = mockRedisOn.mock.calls[0][1] as (error: Error) => void;
    redisErrorHandler(new Error('redis://credential-that-must-not-leak'));
    expect(consoleError).toHaveBeenCalledWith('[QueueService] Queue Redis connection error.');
    expect(metrics.snapshot().counters[0].value).toBe(1);

    consoleError.mockRestore();
  });
});
