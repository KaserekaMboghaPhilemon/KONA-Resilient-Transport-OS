import type * as SQLite from 'expo-sqlite';

import { LocalLedgerGuard } from '../LocalLedgerGuard';
import { LedgerCompromisedError, StateCoordinator } from '../StateCoordinator';

describe('StateCoordinator', () => {
  const DEVICE_SECRET = 'test-device-secret';

  beforeEach(() => {
    jest.restoreAllMocks();
    StateCoordinator.__resetForTesting();
  });

  it('executes exactly one sync path when called concurrently', async () => {
    const db = {} as SQLite.SQLiteDatabase;
    const callOrder: string[] = [];

    let unblockOutbound!: () => void;
    const outboundGate = new Promise<void>((resolve) => {
      unblockOutbound = resolve;
    });

    jest
      .spyOn(LocalLedgerGuard, 'verifyTableIntegrity')
      .mockImplementation(async () => {
        callOrder.push('verify');
        return true;
      });

    const runQueueSync = jest.fn(async () => {
      callOrder.push('queue-start');
      await outboundGate;
      callOrder.push('queue-end');
    });

    const runTelemetrySync = jest.fn(async () => {
      callOrder.push('telemetry');
    });

    StateCoordinator.configure({
      getLedgerDatabase: async () => db,
      getDeviceSecret: async () => DEVICE_SECRET,
      runQueueSync,
      runTelemetrySync,
      haltOutboundTransports: jest.fn(),
    });

    const firstRun = StateCoordinator.syncAllSystems('trip-concurrent-001');
    await Promise.resolve();

    const secondRun = StateCoordinator.syncAllSystems('trip-concurrent-001');
    await secondRun;

    unblockOutbound();
    await firstRun;

    expect(LocalLedgerGuard.verifyTableIntegrity).toHaveBeenCalledTimes(1);
    expect(runQueueSync).toHaveBeenCalledTimes(1);
    expect(runTelemetrySync).toHaveBeenCalledTimes(1);

    const snapshot = StateCoordinator.getSnapshot();
    expect(snapshot.skippedRuns).toBe(1);
    expect(snapshot.successfulRuns).toBe(1);
    expect(snapshot.status).toBe('SYNC_COMPLETED');
    expect(snapshot.isProcessing).toBe(false);
    expect(callOrder).toEqual(['verify', 'queue-start', 'queue-end', 'telemetry']);
  });

  it('halts outbound transport, raises compromised lock state, and remains persistently locked', async () => {
    const db = {} as SQLite.SQLiteDatabase;
    const runQueueSync = jest.fn(async () => undefined);
    const runTelemetrySync = jest.fn(async () => undefined);
    const haltOutboundTransports = jest.fn(async () => undefined);

    jest
      .spyOn(LocalLedgerGuard, 'verifyTableIntegrity')
      .mockResolvedValue(false);

    StateCoordinator.configure({
      getLedgerDatabase: async () => db,
      getDeviceSecret: async () => DEVICE_SECRET,
      runQueueSync,
      runTelemetrySync,
      haltOutboundTransports,
    });

    await expect(
      StateCoordinator.syncAllSystems('trip-lock-001'),
    ).rejects.toBeInstanceOf(LedgerCompromisedError);

    expect(LocalLedgerGuard.verifyTableIntegrity).toHaveBeenCalledTimes(1);
    expect(runQueueSync).not.toHaveBeenCalled();
    expect(runTelemetrySync).not.toHaveBeenCalled();
    expect(haltOutboundTransports).toHaveBeenCalledTimes(1);

    const snapshot = StateCoordinator.getSnapshot();
    expect(snapshot.status).toBe('LEDGER_COMPROMISED_LOCK');
    expect(snapshot.ledgerIntegrityOk).toBe(false);
    expect(snapshot.lastError).toContain('Local ledger integrity verification failed');
    expect(snapshot.isProcessing).toBe(false);

    await expect(
      StateCoordinator.syncAllSystems('trip-lock-001'),
    ).rejects.toBeInstanceOf(LedgerCompromisedError);

    // Must short-circuit before running another audit.
    expect(LocalLedgerGuard.verifyTableIntegrity).toHaveBeenCalledTimes(1);
  });

  it('runs preflight verification before queue sync and telemetry sync on healthy ledger', async () => {
    const db = {} as SQLite.SQLiteDatabase;
    const order: string[] = [];

    jest
      .spyOn(LocalLedgerGuard, 'verifyTableIntegrity')
      .mockImplementation(async () => {
        order.push('verify');
        return true;
      });

    const runQueueSync = jest.fn(async () => {
      order.push('queue');
    });

    const runTelemetrySync = jest.fn(async () => {
      order.push('telemetry');
    });

    StateCoordinator.configure({
      getLedgerDatabase: async () => db,
      getDeviceSecret: async () => DEVICE_SECRET,
      runQueueSync,
      runTelemetrySync,
      haltOutboundTransports: jest.fn(),
    });

    await StateCoordinator.syncAllSystems('trip-healthy-001');

    expect(LocalLedgerGuard.verifyTableIntegrity).toHaveBeenCalledTimes(1);
  expect(runQueueSync).toHaveBeenCalledTimes(1);
  expect(runTelemetrySync).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['verify', 'queue', 'telemetry']);

    const snapshot = StateCoordinator.getSnapshot();
    expect(snapshot.status).toBe('SYNC_COMPLETED');
    expect(snapshot.ledgerIntegrityOk).toBe(true);
    expect(snapshot.successfulRuns).toBe(1);
    expect(snapshot.isProcessing).toBe(false);
  });

  it('unlocks manually only after a clean post-incident audit', async () => {
    const db = {} as SQLite.SQLiteDatabase;

    jest
      .spyOn(LocalLedgerGuard, 'verifyTableIntegrity')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    StateCoordinator.configure({
      getLedgerDatabase: async () => db,
      getDeviceSecret: async () => DEVICE_SECRET,
      runQueueSync: jest.fn(async () => undefined),
      runTelemetrySync: jest.fn(async () => undefined),
      haltOutboundTransports: jest.fn(async () => undefined),
    });

    await expect(
      StateCoordinator.syncAllSystems('trip-lock-002'),
    ).rejects.toBeInstanceOf(LedgerCompromisedError);

    await expect(StateCoordinator.unlockSystemAfterAudit()).resolves.toBeUndefined();

    const snapshot = StateCoordinator.getSnapshot();
    expect(snapshot.status).toBe('IDLE');
    expect(snapshot.ledgerIntegrityOk).toBe(true);
    expect(snapshot.lastError).toBeNull();
  });
});
