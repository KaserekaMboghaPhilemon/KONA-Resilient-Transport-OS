import { createHash } from 'node:crypto';
import { Queue, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';
import { syncMetrics, type SyncMetrics } from './SyncMetrics';

export const NON_FINANCIAL_QUEUE_JOBS = Object.freeze({
  notifications: Object.freeze(['notification_delivery'] as const),
  maintenance: Object.freeze(['cache_maintenance'] as const),
  analytics: Object.freeze(['telemetry_aggregation'] as const),
});

export type NonFinancialQueueName = keyof typeof NON_FINANCIAL_QUEUE_JOBS;
export type NonFinancialJobName =
  (typeof NON_FINANCIAL_QUEUE_JOBS)[NonFinancialQueueName][number];
export type BackgroundJobData = Record<string, unknown>;

export const BACKGROUND_JOB_RETRY_POLICY = Object.freeze({
  attempts: 5,
  backoffDelayMs: 1_000,
});

export const BACKGROUND_JOB_DEFAULT_OPTIONS: JobsOptions = Object.freeze({
  attempts: BACKGROUND_JOB_RETRY_POLICY.attempts,
  backoff: Object.freeze({
    type: 'exponential',
    delay: BACKGROUND_JOB_RETRY_POLICY.backoffDelayMs,
  }),
  removeOnComplete: Object.freeze({ age: 86_400, count: 1_000 }),
  removeOnFail: Object.freeze({ age: 604_800, count: 5_000 }),
});

const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const REDIS_RECONNECT_DELAY_CAP_MS = 5_000;

export class QueueServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueServiceError';
  }
}

function isQueueName(value: string): value is NonFinancialQueueName {
  return Object.prototype.hasOwnProperty.call(NON_FINANCIAL_QUEUE_JOBS, value);
}

function isJobNameForQueue(
  queueName: NonFinancialQueueName,
  jobName: string,
): jobName is NonFinancialJobName {
  return (NON_FINANCIAL_QUEUE_JOBS[queueName] as readonly string[]).includes(jobName);
}

export function createDeterministicJobId(
  queueName: NonFinancialQueueName,
  jobName: NonFinancialJobName,
  idempotencyKey: string,
): string {
  if (
    !isQueueName(queueName) ||
    !isJobNameForQueue(queueName, jobName) ||
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.trim().length === 0 ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new QueueServiceError('Invalid background job identity.');
  }

  const digest = createHash('sha256')
    .update(`${queueName}\0${jobName}\0${idempotencyKey}`)
    .digest('hex');
  return `${queueName}-${digest}`;
}

export interface QueueServiceOptions {
  redisUrl?: string;
  metrics?: SyncMetrics | null;
}

export class QueueService {
  private readonly connection: Redis;
  private readonly metrics: SyncMetrics | null;
  private readonly queues = new Map<
    NonFinancialQueueName,
    Queue<BackgroundJobData>
  >();
  private closePromise: Promise<void> | null = null;

  constructor(options: QueueServiceOptions = {}) {
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
    if (!redisUrl?.trim()) {
      throw new QueueServiceError('REDIS_URL is required for background queues.');
    }

    this.metrics = options.metrics === undefined ? syncMetrics : options.metrics;
    try {
      this.connection = new Redis(redisUrl.trim(), {
        maxRetriesPerRequest: null,
        retryStrategy: (attempt: number) =>
          Math.min(attempt * 250, REDIS_RECONNECT_DELAY_CAP_MS),
      });
    } catch {
      throw new QueueServiceError('Unable to initialize Redis connection.');
    }
    this.connection.on('error', () => {
      this.recordFailure('Queue Redis connection error.');
    });
  }

  registerQueue(queueName: NonFinancialQueueName): void {
    this.assertOpen();
    if (!isQueueName(queueName)) {
      throw new QueueServiceError('Unsupported background queue.');
    }
    if (this.queues.has(queueName)) {
      return;
    }

    try {
      const queue = new Queue<BackgroundJobData>(queueName, {
        connection: this.connection,
        defaultJobOptions: { ...BACKGROUND_JOB_DEFAULT_OPTIONS },
      });
      queue.on('error', () => {
        this.recordFailure('Background queue error.');
      });
      this.queues.set(queueName, queue);
    } catch {
      this.recordFailure('Background queue registration failed.');
      throw new QueueServiceError('Unable to register background queue.');
    }
  }

  async enqueue(
    queueName: NonFinancialQueueName,
    jobName: NonFinancialJobName,
    idempotencyKey: string,
    data: BackgroundJobData,
  ): Promise<unknown> {
    this.assertOpen();
    if (!isQueueName(queueName) || !isJobNameForQueue(queueName, jobName)) {
      throw new QueueServiceError('Unsupported background queue job.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new QueueServiceError('Background job data must be an object.');
    }

    const jobId = createDeterministicJobId(queueName, jobName, idempotencyKey);
    this.registerQueue(queueName);
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new QueueServiceError('Background queue is unavailable.');
    }

    const enqueueJob = (): Promise<unknown> =>
      queue.add(jobName, data, { jobId });
    try {
      const job = this.metrics
        ? await this.metrics.timeOperation(
            { operation: 'background_job', transport: 'none' },
            enqueueJob,
          )
        : await enqueueJob();
      this.metrics?.incrementSyncOperations({
        operation: 'background_job',
        transport: 'none',
        outcome: 'success',
      });
      return job;
    } catch {
      this.recordFailure('Background job enqueue failed.');
      throw new QueueServiceError('Unable to enqueue background job.');
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeResources();
    }
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const closeResults = await Promise.allSettled(
      [...this.queues.values()].map(async (queue) => queue.close()),
    );
    let redisCloseFailed = false;

    try {
      if (this.connection.status === 'ready') {
        await this.connection.quit();
      } else {
        this.connection.disconnect();
      }
    } catch {
      redisCloseFailed = true;
      this.connection.disconnect();
    }

    if (
      redisCloseFailed ||
      closeResults.some((result) => result.status === 'rejected')
    ) {
      this.recordFailure('Background queue shutdown failed.');
      throw new QueueServiceError('Unable to close background queue resources.');
    }

    this.queues.clear();
  }

  private assertOpen(): void {
    if (this.closePromise) {
      throw new QueueServiceError('Queue service is closed.');
    }
  }

  private recordFailure(message: string): void {
    this.metrics?.incrementSyncOperations({
      operation: 'background_job',
      transport: 'none',
      outcome: 'failure',
    });
    console.error(`[QueueService] ${message}`);
  }
}
