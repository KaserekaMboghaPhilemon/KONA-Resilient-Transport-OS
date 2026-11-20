import {
  SyncMetrics,
  type SyncDurationLabels,
  type SyncOperationLabels,
} from '../SyncMetrics';

const operationLabels: SyncOperationLabels = {
  operation: 'offline_sync',
  transport: 'http',
  outcome: 'success',
};

const durationLabels: SyncDurationLabels = {
  operation: 'telemetry_sync',
  transport: 'sms',
};

describe('SyncMetrics', () => {
  it('increments counters independently for each bounded label combination', () => {
    const metrics = new SyncMetrics();
    metrics.incrementSyncOperations(operationLabels);
    metrics.incrementSyncOperations(operationLabels, 2);
    metrics.incrementSyncOperations({ ...operationLabels, outcome: 'retry' });

    expect(metrics.snapshot().counters).toEqual([
      {
        name: 'kona_sync_operations_total',
        labels: { ...operationLabels, outcome: 'retry' },
        value: 1,
      },
      {
        name: 'kona_sync_operations_total',
        labels: operationLabels,
        value: 3,
      },
    ]);
  });

  it('updates queue depth gauges and rejects invalid values', () => {
    const metrics = new SyncMetrics();
    metrics.setQueueDepth('offline_sync', 4);
    metrics.setQueueDepth('offline_sync', 1);

    expect(metrics.snapshot().gauges).toEqual([
      {
        name: 'kona_sync_queue_depth',
        labels: { queue: 'offline_sync' },
        value: 1,
      },
    ]);
    expect(() => metrics.setQueueDepth('offline_sync', -1)).toThrow(RangeError);
    expect(() => metrics.setQueueDepth('offline_sync', 1.5)).toThrow(RangeError);
  });

  it('records durations in seconds and accumulates histogram buckets', () => {
    const metrics = new SyncMetrics();
    metrics.recordOperationDuration(durationLabels, 10);
    metrics.recordOperationDuration(durationLabels, 100);

    const histogram = metrics.snapshot().histograms[0];
    expect(histogram).toMatchObject({
      count: 2,
      sumSeconds: 0.11,
    });
    expect(histogram.buckets.find((bucket) => bucket.leSeconds === 0.01)?.count).toBe(1);
    expect(histogram.buckets.find((bucket) => bucket.leSeconds === 0.1)?.count).toBe(2);
    expect(histogram.buckets.find((bucket) => bucket.leSeconds === '+Inf')?.count).toBe(2);
    expect(() => metrics.recordOperationDuration(durationLabels, Number.NaN)).toThrow(RangeError);
    expect(() => metrics.recordOperationDuration(durationLabels, -1)).toThrow(RangeError);
  });

  it('times successful and rejected operations using a monotonic clock', async () => {
    let now = 100;
    const metrics = new SyncMetrics(() => now);
    const success = metrics.timeOperation(durationLabels, () => {
      now += 20;
      return 'done';
    });
    await expect(success).resolves.toBe('done');

    const failure = metrics.timeOperation(durationLabels, () => {
      now += 30;
      throw new Error('operation failed');
    });
    await expect(failure).rejects.toThrow('operation failed');

    expect(metrics.snapshot().histograms[0]).toMatchObject({
      count: 2,
      sumSeconds: 0.05,
    });
  });

  it('rejects unbounded, unexpected, and sensitive label values without retaining them', async () => {
    const metrics = new SyncMetrics();
    const labelsWithIdentifier = {
      ...operationLabels,
      tripId: 'trip-secret-value',
    } as SyncOperationLabels;
    const labelsWithCredential = {
      ...operationLabels,
      outcome: 'api-key-secret-value',
    } as unknown as SyncOperationLabels;

    expect(() => metrics.incrementSyncOperations(labelsWithIdentifier)).toThrow(
      /bounded values/,
    );
    expect(() => metrics.incrementSyncOperations(labelsWithCredential)).toThrow(
      /bounded values/,
    );
    const operation = jest.fn();
    await expect(metrics.timeOperation(labelsWithIdentifier, operation)).rejects.toThrow(
      /bounded values/,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(metrics.toPrometheus()).not.toContain('trip-secret-value');
    expect(metrics.toPrometheus()).not.toContain('api-key-secret-value');
  });

  it('rejects invalid counter increments and returns defensive snapshots', () => {
    const metrics = new SyncMetrics();
    metrics.incrementSyncOperations(operationLabels);

    expect(() => metrics.incrementSyncOperations(operationLabels, 0)).toThrow(RangeError);
    expect(() => metrics.incrementSyncOperations(operationLabels, 1.5)).toThrow(RangeError);

    const snapshot = metrics.snapshot();
    snapshot.counters[0].labels.operation = 'background_job';
    snapshot.counters[0].value = 100;

    expect(metrics.snapshot().counters[0]).toMatchObject({
      labels: operationLabels,
      value: 1,
    });
  });

  it('renders deterministic Prometheus-style counter, gauge, and histogram output', () => {
    const metrics = new SyncMetrics();
    metrics.incrementSyncOperations(operationLabels);
    metrics.setQueueDepth('telemetry', 2);
    metrics.recordOperationDuration(durationLabels, 10);

    expect(metrics.toPrometheus()).toContain(
      'kona_sync_operations_total{operation="offline_sync",transport="http",outcome="success"} 1',
    );
    expect(metrics.toPrometheus()).toContain('kona_sync_queue_depth{queue="telemetry"} 2');
    expect(metrics.toPrometheus()).toContain(
      'kona_sync_operation_duration_seconds_bucket{operation="telemetry_sync",transport="sms",le="0.01"} 1',
    );
    expect(metrics.toPrometheus()).toContain(
      'kona_sync_operation_duration_seconds_count{operation="telemetry_sync",transport="sms"} 1',
    );
    expect(metrics.toPrometheus().endsWith('\n')).toBe(true);
  });
});
