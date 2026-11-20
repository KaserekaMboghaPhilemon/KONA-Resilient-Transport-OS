import { createHash } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import {
  NON_FINANCIAL_QUEUE_JOBS,
  type BackgroundJobData,
  type NonFinancialJobName,
  type NonFinancialQueueName,
} from '../services/QueueService';
import { syncMetrics, type SyncMetrics } from '../services/SyncMetrics';

export const DEFAULT_BACKGROUND_WORKER_CONCURRENCY = 2;
export const MAX_BACKGROUND_WORKER_CONCURRENCY = 8;
export const COMPLETED_BACKGROUND_JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

const REDIS_RECONNECT_DELAY_CAP_MS = 5_000;

export interface BackgroundJobContext {
  jobId: string;
  idempotencyKey: string;
  attemptsMade: number;
}

export type NonFinancialJobHandler = (
  data: BackgroundJobData,
  context: BackgroundJobContext,
) => Promise<void>;

export type NonFinancialJobHandlers = Partial<
  Record<NonFinancialJobName, NonFinancialJobHandler>
>;

export interface WorkerSignalSource {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  removeListener(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

export interface NonFinancialWorkerOptions {
  redisUrl?: string;
  concurrency?: number;
  metrics?: SyncMetrics | null;
  signalSource?: WorkerSignalSource;
}

export class NonFinancialWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonFinancialWorkerError';
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

function completedJobKey(queueName: NonFinancialQueueName, jobId: string): string {
  const digest = createHash('sha256')
    .update(`${queueName}\0${jobId}`)
    .digest('hex');
  return `kona:background:completed:${queueName}:${digest}`;
}

export class NonFinancialWorker {
  private readonly connection: Redis;
  private readonly worker: Worker<BackgroundJobData>;
  private readonly metrics: SyncMetrics | null;
  private readonly queueName: NonFinancialQueueName;
  private closePromise: Promise<void> | null = null;
  private removeSignalHandlers: (() => void) | null = null;

  constructor(
    queueName: NonFinancialQueueName,
    handlers: NonFinancialJobHandlers,
    options: NonFinancialWorkerOptions = {},
  ) {
    if (!isQueueName(queueName)) {
      throw new NonFinancialWorkerError('Unsupported non-financial worker queue.');
    }

    const jobNames = NON_FINANCIAL_QUEUE_JOBS[queueName];
    if (jobNames.some((jobName) => typeof handlers[jobName] !== 'function')) {
      throw new NonFinancialWorkerError('A handler is required for every supported queue job.');
    }

    const concurrency = options.concurrency ?? DEFAULT_BACKGROUND_WORKER_CONCURRENCY;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > MAX_BACKGROUND_WORKER_CONCURRENCY
    ) {
      throw new NonFinancialWorkerError('Worker concurrency is outside the configured bounds.');
    }

    const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
    if (!redisUrl?.trim()) {
      throw new NonFinancialWorkerError('REDIS_URL is required for background workers.');
    }

    this.queueName = queueName;
    this.metrics = options.metrics === undefined ? syncMetrics : options.metrics;

    try {
      this.connection = new Redis(redisUrl.trim(), {
        maxRetriesPerRequest: null,
        retryStrategy: (attempt: number) =>
          Math.min(attempt * 250, REDIS_RECONNECT_DELAY_CAP_MS),
      });
    } catch {
      throw new NonFinancialWorkerError('Unable to initialize worker Redis connection.');
    }

    this.connection.on('error', () => {
      this.recordFailure('Worker Redis connection error.');
    });

    try {
      this.worker = new Worker<BackgroundJobData>(
        queueName,
        (job) => this.processJob(job, handlers),
        { connection: this.connection, concurrency },
      );
      this.worker.on('error', () => {
        this.recordFailure('Background worker runtime error.');
      });
    } catch {
      this.connection.disconnect();
      throw new NonFinancialWorkerError('Unable to start background worker.');
    }
  }

  installSignalHandlers(signalSource: WorkerSignalSource = process): () => void {
    if (this.removeSignalHandlers) {
      return this.removeSignalHandlers;
    }

    let shuttingDown = false;
    const onSignal = (): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      this.removeSignalHandlers?.();
      void this.close().catch(() => {
        console.error('[NonFinancialWorker] Graceful shutdown failed.');
        process.exitCode = 1;
      });
    };

    const removeHandlers = (): void => {
      signalSource.removeListener('SIGTERM', onSignal);
      signalSource.removeListener('SIGINT', onSignal);
      if (this.removeSignalHandlers === removeHandlers) {
        this.removeSignalHandlers = null;
      }
    };

    this.removeSignalHandlers = removeHandlers;
    signalSource.once('SIGTERM', onSignal);
    signalSource.once('SIGINT', onSignal);
    return removeHandlers;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.removeSignalHandlers?.();
      this.closePromise = this.closeResources();
    }
    return this.closePromise;
  }

  private async processJob(
    job: Job<BackgroundJobData>,
    handlers: NonFinancialJobHandlers,
  ): Promise<void> {
    const labels = { operation: 'background_job', transport: 'none' } as const;
    const process = async (): Promise<void> => {
      try {
        if (
          !job ||
          typeof job.id !== 'string' ||
          job.id.length === 0 ||
          !isJobNameForQueue(this.queueName, job.name) ||
          !job.data ||
          typeof job.data !== 'object' ||
          Array.isArray(job.data)
        ) {
          throw new NonFinancialWorkerError('Invalid non-financial background job.');
        }

        const key = completedJobKey(this.queueName, job.id);
        if (await this.connection.get(key)) {
          this.recordSuccess();
          return;
        }

        const handler = handlers[job.name];
        if (!handler) {
          throw new NonFinancialWorkerError('No handler is registered for this background job.');
        }

        await handler(job.data, {
          jobId: job.id,
          idempotencyKey: job.id,
          attemptsMade: job.attemptsMade,
        });
        await this.connection.set(
          key,
          'completed',
          'EX',
          COMPLETED_BACKGROUND_JOB_TTL_SECONDS,
        );
        this.recordSuccess();
      } catch {
        this.recordFailure('Background job processing failed.');
        throw new NonFinancialWorkerError(
          'Non-financial background job failed and may be retried.',
        );
      }
    };

    return this.metrics ? this.metrics.timeOperation(labels, process) : process();
  }

  private async closeResources(): Promise<void> {
    let closeFailed = false;
    try {
      await this.worker.close();
    } catch {
      closeFailed = true;
    }

    try {
      if (this.connection.status === 'ready') {
        await this.connection.quit();
      } else {
        this.connection.disconnect();
      }
    } catch {
      closeFailed = true;
      this.connection.disconnect();
    }

    if (closeFailed) {
      this.recordFailure('Background worker shutdown failed.');
      throw new NonFinancialWorkerError('Unable to close background worker resources.');
    }
  }

  private recordSuccess(): void {
    this.metrics?.incrementSyncOperations({
      operation: 'background_job',
      transport: 'none',
      outcome: 'success',
    });
  }

  private recordFailure(message: string): void {
    this.metrics?.incrementSyncOperations({
      operation: 'background_job',
      transport: 'none',
      outcome: 'failure',
    });
    console.error(`[NonFinancialWorker] ${message}`);
  }
}

export function startNonFinancialWorker(
  queueName: NonFinancialQueueName,
  handlers: NonFinancialJobHandlers,
  options: NonFinancialWorkerOptions = {},
): NonFinancialWorker {
  const worker = new NonFinancialWorker(queueName, handlers, options);
  worker.installSignalHandlers(options.signalSource);
  return worker;
}
