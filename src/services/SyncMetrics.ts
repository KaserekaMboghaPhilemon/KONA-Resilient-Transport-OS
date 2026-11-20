import { performance } from 'node:perf_hooks';

export const SYNC_OPERATIONS = Object.freeze([
  'offline_sync',
  'telemetry_sync',
  'background_job',
] as const);
export type SyncOperation = (typeof SYNC_OPERATIONS)[number];

export const SYNC_TRANSPORTS = Object.freeze(['http', 'sms', 'bluetooth', 'none'] as const);
export type SyncTransport = (typeof SYNC_TRANSPORTS)[number];

export const SYNC_OUTCOMES = Object.freeze(['success', 'failure', 'retry'] as const);
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

export const SYNC_QUEUES = Object.freeze(['offline_sync', 'telemetry'] as const);
export type SyncQueue = (typeof SYNC_QUEUES)[number];

export interface SyncOperationLabels {
  operation: SyncOperation;
  transport: SyncTransport;
  outcome: SyncOutcome;
}

export interface SyncDurationLabels {
  operation: SyncOperation;
  transport: SyncTransport;
}

export interface SyncMetricsSnapshot {
  counters: Array<{
    name: 'kona_sync_operations_total';
    labels: SyncOperationLabels;
    value: number;
  }>;
  gauges: Array<{
    name: 'kona_sync_queue_depth';
    labels: { queue: SyncQueue };
    value: number;
  }>;
  histograms: Array<{
    name: 'kona_sync_operation_duration_seconds';
    labels: SyncDurationLabels;
    count: number;
    sumSeconds: number;
    buckets: Array<{ leSeconds: number | '+Inf'; count: number }>;
  }>;
}

const DURATION_BUCKETS_SECONDS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
  60,
] as const;

const LABEL_ERROR =
  'Invalid SyncMetrics labels. Use only configured label keys and bounded values.';

interface CounterSample {
  labels: SyncOperationLabels;
  value: number;
}

interface GaugeSample {
  labels: { queue: SyncQueue };
  value: number;
}

interface HistogramSample {
  labels: SyncDurationLabels;
  count: number;
  sumSeconds: number;
  bucketCounts: number[];
}

function isOneOf<T extends string>(
  value: unknown,
  options: readonly T[],
): value is T {
  return typeof value === 'string' && options.some((option) => option === value);
}

function normalizeOperationLabels(value: SyncOperationLabels): SyncOperationLabels {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(value, 'operation') ||
    !Object.prototype.hasOwnProperty.call(value, 'transport') ||
    !Object.prototype.hasOwnProperty.call(value, 'outcome') ||
    !isOneOf(value.operation, SYNC_OPERATIONS) ||
    !isOneOf(value.transport, SYNC_TRANSPORTS) ||
    !isOneOf(value.outcome, SYNC_OUTCOMES)
  ) {
    throw new TypeError(LABEL_ERROR);
  }

  return {
    operation: value.operation,
    transport: value.transport,
    outcome: value.outcome,
  };
}

function normalizeDurationLabels(value: SyncDurationLabels): SyncDurationLabels {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, 'operation') ||
    !Object.prototype.hasOwnProperty.call(value, 'transport') ||
    !isOneOf(value.operation, SYNC_OPERATIONS) ||
    !isOneOf(value.transport, SYNC_TRANSPORTS)
  ) {
    throw new TypeError(LABEL_ERROR);
  }

  return { operation: value.operation, transport: value.transport };
}

function labelsKey(labels: object): string {
  return JSON.stringify(Object.values(labels));
}

function compareLabels(left: object, right: object): number {
  return labelsKey(left).localeCompare(labelsKey(right));
}

function formatLabels(labels: object, extra?: [string, string]): string {
  const entries = Object.entries(labels);
  if (extra) {
    entries.push(extra);
  }
  if (entries.length === 0) {
    return '';
  }

  return `{${entries
    .map(([key, value]) => {
      const escaped = String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
      return `${key}="${escaped}"`;
    })
    .join(',')}}`;
}

export class SyncMetrics {
  private readonly counters = new Map<string, CounterSample>();
  private readonly gauges = new Map<string, GaugeSample>();
  private readonly histograms = new Map<string, HistogramSample>();

  constructor(private readonly clock: () => number = () => performance.now()) {}

  incrementSyncOperations(labels: SyncOperationLabels, amount = 1): void {
    const boundedLabels = normalizeOperationLabels(labels);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new RangeError('SyncMetrics counter increments must be positive safe integers.');
    }

    const key = labelsKey(boundedLabels);
    const current = this.counters.get(key)?.value ?? 0;
    const value = current + amount;
    if (!Number.isSafeInteger(value)) {
      throw new RangeError('SyncMetrics counter value exceeds the safe integer range.');
    }
    this.counters.set(key, { labels: boundedLabels, value });
  }

  setQueueDepth(queue: SyncQueue, depth: number): void {
    if (
      !isOneOf(queue, SYNC_QUEUES) ||
      !Number.isSafeInteger(depth) ||
      depth < 0
    ) {
      throw new RangeError('SyncMetrics queue depth requires a configured queue and non-negative integer.');
    }

    const labels = { queue };
    this.gauges.set(labelsKey(labels), { labels, value: depth });
  }

  recordOperationDuration(labels: SyncDurationLabels, durationMs: number): void {
    const boundedLabels = normalizeDurationLabels(labels);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError('SyncMetrics duration must be a finite non-negative number of milliseconds.');
    }

    const key = labelsKey(boundedLabels);
    const sample = this.histograms.get(key) ?? {
      labels: boundedLabels,
      count: 0,
      sumSeconds: 0,
      bucketCounts: DURATION_BUCKETS_SECONDS.map(() => 0),
    };
    const durationSeconds = durationMs / 1000;
    const nextSum = sample.sumSeconds + durationSeconds;
    if (!Number.isFinite(nextSum) || !Number.isSafeInteger(sample.count + 1)) {
      throw new RangeError('SyncMetrics histogram value exceeds the supported range.');
    }

    sample.count += 1;
    sample.sumSeconds = nextSum;
    DURATION_BUCKETS_SECONDS.forEach((boundary, index) => {
      if (durationSeconds <= boundary) {
        sample.bucketCounts[index] += 1;
      }
    });
    this.histograms.set(key, sample);
  }

  async timeOperation<T>(
    labels: SyncDurationLabels,
    operation: () => T | PromiseLike<T>,
  ): Promise<T> {
    const boundedLabels = normalizeDurationLabels(labels);
    const startedAt = this.clock();
    try {
      return await operation();
    } finally {
      this.recordOperationDuration(boundedLabels, this.clock() - startedAt);
    }
  }

  snapshot(): SyncMetricsSnapshot {
    return {
      counters: [...this.counters.values()]
        .sort((left, right) => compareLabels(left.labels, right.labels))
        .map(({ labels, value }) => ({
          name: 'kona_sync_operations_total',
          labels: { ...labels },
          value,
        })),
      gauges: [...this.gauges.values()]
        .sort((left, right) => compareLabels(left.labels, right.labels))
        .map(({ labels, value }) => ({
          name: 'kona_sync_queue_depth',
          labels: { ...labels },
          value,
        })),
      histograms: [...this.histograms.values()]
        .sort((left, right) => compareLabels(left.labels, right.labels))
        .map((sample) => ({
          name: 'kona_sync_operation_duration_seconds',
          labels: { ...sample.labels },
          count: sample.count,
          sumSeconds: sample.sumSeconds,
          buckets: [
            ...DURATION_BUCKETS_SECONDS.map((leSeconds, index) => ({
              leSeconds,
              count: sample.bucketCounts[index],
            })),
            { leSeconds: '+Inf' as const, count: sample.count },
          ],
        })),
    };
  }

  toPrometheus(): string {
    const snapshot = this.snapshot();
    const lines = [
      '# HELP kona_sync_operations_total Number of sync operations by bounded operation, transport, and outcome.',
      '# TYPE kona_sync_operations_total counter',
      ...snapshot.counters.map(
        ({ labels, value }) =>
          `kona_sync_operations_total${formatLabels(labels)} ${value}`,
      ),
      '# HELP kona_sync_queue_depth Current number of queued sync items.',
      '# TYPE kona_sync_queue_depth gauge',
      ...snapshot.gauges.map(
        ({ labels, value }) => `kona_sync_queue_depth${formatLabels(labels)} ${value}`,
      ),
      '# HELP kona_sync_operation_duration_seconds Sync operation duration in seconds.',
      '# TYPE kona_sync_operation_duration_seconds histogram',
    ];

    for (const histogram of snapshot.histograms) {
      for (const bucket of histogram.buckets) {
        lines.push(
          `kona_sync_operation_duration_seconds_bucket${formatLabels(
            histogram.labels,
            ['le', String(bucket.leSeconds)],
          )} ${bucket.count}`,
        );
      }
      lines.push(
        `kona_sync_operation_duration_seconds_sum${formatLabels(histogram.labels)} ${histogram.sumSeconds}`,
      );
      lines.push(
        `kona_sync_operation_duration_seconds_count${formatLabels(histogram.labels)} ${histogram.count}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }
}
