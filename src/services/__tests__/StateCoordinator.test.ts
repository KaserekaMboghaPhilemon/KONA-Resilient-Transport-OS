import type * as SQLite from 'expo-sqlite';

import { LocalLedgerGuard } from '../LocalLedgerGuard';
import { StateCoordinator } from '../StateCoordinator';

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

    const runOutboundSync = jest.fn(async () => {
      callOrder.push('outbound-start');
      await outboundGate;
      callOrder.push('outbound-end');
    });

    StateCoordinator.configure({
      getLedgerDatabase: async () => db,
      getDeviceSecret: async () => DEVICE_SECRET,
      runOutboundSync,
      haltOutboundTransports: jest.fn(),
    });

    const firstRun = StateCoordinator.syncAllSystems('trip-concurrent-001');
    await Promise.resolve();

    const secondRun = StateCoordinator.syncAllSystems('trip-concurrent-001');
    await secondRun;

    unblockOutbound();
    await firstRun;

    expect(LocalLedgerGuard.verifyTableIntegrity).toHaveBeenCalledTimes(1);
    expect(runOutboundSync).toHaveBeenCalledTimes(1);

    const snapshot = StateCoordinator.getSnapshot();
    expect(snapshot.skippedRuns).toBe(1);
    expect(snapshot.successfulRuns).toBe(1);
    expect(snapshot.status).toBe('SYNC_COMPLETED');
    expect(snapshot.isProcessing).toBe(false);
    expect(callOrder).toEqual(['verify', 'outbound-start', 'outbound-end']);
  });

  it('halts outbound transport and raises compromised lock state when ledger audit fails', async () => {
    const db = {} as SQLite.SQLiteDatabase;
    const runOutboundSync = jest.fn(async () => undefined);
    const haltOutboundTransports = jest.fn(async () => undefined);

    jest
      .spyOn(LocalLedgerGuard, 'verifyTableIntegrity')
      .mockResolvedValue(false);

    StateCoordinator.configure({
      getLedgerDatabase: async () => db,
      getDeviceSecret: async () => DEVICE_SECRET,
      runOutboundSync,
      haltOutboundTransports,
    });

    await StateCoordinator.syncAllSystems('trip-lock-001');

    expect(LocalLedgerGuard.verifyTableIntegrity).toHaveBeenCalledTimes(1);
    expect(runOutboundSync).not.toHaveBeenCalled();
    expect(haltOutboundTransports).toHaveBeenCalledTimes(1);

    const snapshot = StateCoordinator.getSnapshot();
    expect(snapshot.status).toBe('LEDGER_COMPROMISED_LOCK');
    expect(snapshot.ledgerIntegrityOk).toBe(false);
    expect(snapshot.lastError).toContain('Local ledger integrity verification failed');
    expect(snapshot.isProcessing).toBe(false);
  });

  it('runs preflight verification before outbound sync on healthy ledger', async () => {
    const db = {} as SQLite.SQLiteDatabase;
    const order: string[] = [];

    jest
      .spyOn(LocalLedgerGuard, 'verifyTableIntegrity')
      .mockImplementation(async () => {
        order.push('verify');
        return true;
      });

    const runOutboundSync = jest.fn(async () => {
      order.push('outbound');
    });

    StateCoordinator.configure({
      getLedgerDatabase: async () => db,
      getDeviceSecret: async () => DEVICE_SECRET,
      runOutboundSync,
      haltOutboundTransports: jest.fn(),
    });

    await StateCoordinator.syncAllSystems('trip-healthy-001');

    expect(LocalLedgerGuard.verifyTableIntegrity).toHaveBeenCalledTimes(1);
    expect(runOutboundSync).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['verify', 'outbound']);

    const snapshot = StateCoordinator.getSnapshot();
    expect(snapshot.status).toBe('SYNC_COMPLETED');
    expect(snapshot.ledgerIntegrityOk).toBe(true);
    expect(snapshot.successfulRuns).toBe(1);
    expect(snapshot.isProcessing).toBe(false);
  });
});
