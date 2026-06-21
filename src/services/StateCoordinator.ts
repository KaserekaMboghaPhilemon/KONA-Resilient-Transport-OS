import type * as SQLite from 'expo-sqlite';
import { LocalLedgerGuard } from './LocalLedgerGuard';

export type CoordinatorEngineStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'SYNC_COMPLETED'
  | 'SYNC_SKIPPED_LOCKED'
  | 'LEDGER_COMPROMISED_LOCK'
  | 'SYNC_FAILED';

export interface StateCoordinatorSnapshot {
  status: CoordinatorEngineStatus;
  isProcessing: boolean;
  activeTripId: string | null;
  ledgerIntegrityOk: boolean | null;
  lastError: string | null;
  lastRunStartedAt: number | null;
  lastRunFinishedAt: number | null;
  successfulRuns: number;
  failedRuns: number;
  skippedRuns: number;
}

export type CoordinatorSnapshot = StateCoordinatorSnapshot;

export type StateCoordinatorListener = (
  snapshot: Readonly<StateCoordinatorSnapshot>,
) => void;

export class LedgerCompromisedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerCompromisedError';
  }
}

interface StateCoordinatorDependencies {
  getLedgerDatabase: () => Promise<SQLite.SQLiteDatabase>;
  getDeviceSecret: () => Promise<string>;
  verifyTableName: string;
  runQueueSync: (tripId: string) => Promise<void>;
  runTelemetrySync: (tripId: string) => Promise<void>;
  haltOutboundTransports: () => void | Promise<void>;
}

const DEFAULT_VERIFY_TABLE = 'pending_sync_queue';

type SyncManagerLike = {
  processOfflineQueue: () => Promise<unknown>;
  stopConnectivityMonitor: () => void;
};

function createDefaultDependencies(): StateCoordinatorDependencies {
  return {
    getLedgerDatabase: async () => {
      const { SQLiteSyncRepository } = await import('./SQLiteSyncRepository');
      return SQLiteSyncRepository.initialize();
    },
    getDeviceSecret: async () => StateCoordinator.resolveDeviceSecret(),
    verifyTableName: DEFAULT_VERIFY_TABLE,
    runQueueSync: async () => {
      const syncManager = await StateCoordinator.getOrCreateDefaultSyncManager();
      await syncManager.processOfflineQueue();
    },
    runTelemetrySync: async (tripId: string) => {
      const { TelemetrySyncManager } = await import('./TelemetrySyncManager');
      await TelemetrySyncManager.forceTelemetrySync(tripId);
    },
    haltOutboundTransports: async () => {
      const syncManager = await StateCoordinator.getOrCreateDefaultSyncManager();
      syncManager.stopConnectivityMonitor();

      // Stop periodic telemetry dispatch to ensure no more outbound transport
      // occurs after a compromised-ledger lock is raised.
      const { TelemetrySyncManager } = await import('./TelemetrySyncManager');
      TelemetrySyncManager.stopPeriodicSync();
    },
  };
}

export class StateCoordinator {
  private static isProcessing = false;
  private static listeners = new Set<StateCoordinatorListener>();
  private static dependencies: StateCoordinatorDependencies = createDefaultDependencies();
  private static defaultSyncManager: SyncManagerLike | null = null;

  private static state: StateCoordinatorSnapshot = {
    status: 'IDLE',
    isProcessing: false,
    activeTripId: null,
    ledgerIntegrityOk: null,
    lastError: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    successfulRuns: 0,
    failedRuns: 0,
    skippedRuns: 0,
  };

  public static configure(params: Partial<StateCoordinatorDependencies>): void {
    this.dependencies = {
      ...this.dependencies,
      ...params,
      verifyTableName: params.verifyTableName ?? this.dependencies.verifyTableName,
    };
  }

  public static subscribe(listener: StateCoordinatorListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public static getSnapshot(): Readonly<StateCoordinatorSnapshot> {
    return { ...this.state };
  }

  public static async syncAllSystems(tripId: string): Promise<void> {
    if (this.state.status === 'LEDGER_COMPROMISED_LOCK') {
      throw new LedgerCompromisedError(
        '[StateCoordinator] Coordinator is locked due to compromised ledger state. Run unlockSystemAfterAudit() after remediation.',
      );
    }

    const normalizedTripId = tripId.trim();
    if (!normalizedTripId) {
      throw new TypeError('[StateCoordinator] syncAllSystems requires a non-empty tripId.');
    }

    if (this.isProcessing) {
      this.state = {
        ...this.state,
        status: 'SYNC_SKIPPED_LOCKED',
        skippedRuns: this.state.skippedRuns + 1,
      };
      this.emit();
      return;
    }

    this.isProcessing = true;
    this.state = {
      ...this.state,
      status: 'RUNNING',
      isProcessing: true,
      activeTripId: normalizedTripId,
      lastError: null,
      ledgerIntegrityOk: null,
      lastRunStartedAt: Date.now(),
      lastRunFinishedAt: null,
    };
    this.emit();

    try {
      const db = await this.dependencies.getLedgerDatabase();
      const deviceSecret = await this.dependencies.getDeviceSecret();
      const integrityOk = await LocalLedgerGuard.verifyTableIntegrity(
        db,
        this.dependencies.verifyTableName,
        deviceSecret,
      );

      if (!integrityOk) {
        const error = new LedgerCompromisedError(
          '[StateCoordinator] Local ledger integrity verification failed. Coordinator locked.',
        );
        await this.dependencies.haltOutboundTransports();

        this.state = {
          ...this.state,
          status: 'LEDGER_COMPROMISED_LOCK',
          ledgerIntegrityOk: false,
          lastError: error.message,
        };
        this.emit();
        throw error;
      }

      this.state = {
        ...this.state,
        ledgerIntegrityOk: true,
      };
      this.emit();

      await this.dependencies.runQueueSync(normalizedTripId);
      await this.dependencies.runTelemetrySync(normalizedTripId);

      this.state = {
        ...this.state,
        status: 'SYNC_COMPLETED',
        successfulRuns: this.state.successfulRuns + 1,
      };
      this.emit();
    } catch (error) {
      if (error instanceof LedgerCompromisedError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.state = {
        ...this.state,
        status: 'SYNC_FAILED',
        failedRuns: this.state.failedRuns + 1,
        lastError: message,
      };
      this.emit();
      throw error;
    } finally {
      this.isProcessing = false;
      this.state = {
        ...this.state,
        isProcessing: false,
        activeTripId: null,
        lastRunFinishedAt: Date.now(),
      };
      this.emit();
    }
  }

  /**
   * Manual recovery operation: re-audits the ledger and unlocks the
   * coordinator only when the chain verifies cleanly.
   */
  public static async unlockSystemAfterAudit(): Promise<void> {
    if (this.state.status !== 'LEDGER_COMPROMISED_LOCK') {
      return;
    }

    const db = await this.dependencies.getLedgerDatabase();
    const deviceSecret = await this.dependencies.getDeviceSecret();
    const integrityOk = await LocalLedgerGuard.verifyTableIntegrity(
      db,
      this.dependencies.verifyTableName,
      deviceSecret,
    );

    if (!integrityOk) {
      throw new LedgerCompromisedError(
        '[StateCoordinator] Unlock denied: ledger integrity verification still failing.',
      );
    }

    this.state = {
      ...this.state,
      status: 'IDLE',
      ledgerIntegrityOk: true,
      lastError: null,
    };
    this.emit();
  }

  /**
   * Test helper: restores static coordinator state and default dependencies.
   */
  public static __resetForTesting(): void {
    this.isProcessing = false;
    this.listeners.clear();
    this.defaultSyncManager = null;
    this.dependencies = createDefaultDependencies();
    this.state = {
      status: 'IDLE',
      isProcessing: false,
      activeTripId: null,
      ledgerIntegrityOk: null,
      lastError: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      successfulRuns: 0,
      failedRuns: 0,
      skippedRuns: 0,
    };
  }

  private static emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  static async getOrCreateDefaultSyncManager(): Promise<SyncManagerLike> {
    if (this.defaultSyncManager !== null) {
      return this.defaultSyncManager;
    }

    const { SyncManager } = await import('./SyncManager');
    const { SMSTransportManager } = await import('./SMSTransportManager');

    this.defaultSyncManager = new SyncManager({
      connectivityProbe: {
        getState: async () => this.resolveConnectivityState(),
      },
      httpsAdapter: {
        post: async (params) => {
          const base = this.resolveApiBaseUrl();
          const response = await fetch(`${base}/api/v1/sync/action`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': params.idempotency_key,
            },
            body: JSON.stringify(params),
          });

          return response.ok;
        },
      },
      smsAdapter: {
        send: async (wireString) => {
          const tx = await SMSTransportManager.create();
          return tx.send(wireString);
        },
      },
    }) as SyncManagerLike;

    return this.defaultSyncManager;
  }

  private static async resolveConnectivityState(): Promise<'internet' | 'sms_only' | 'none'> {
    if (typeof fetch === 'function') {
      try {
        const probe = await fetch('https://clients3.google.com/generate_204', {
          method: 'GET',
        });
        if (probe.ok || probe.status === 204) {
          return 'internet';
        }
      } catch {
        // Fall through to SMS probe.
      }
    }

    try {
      const smsModule = this.tryRequire<{ isAvailableAsync: () => Promise<boolean> }>('expo-sms');
      if (smsModule && (await smsModule.isAvailableAsync())) {
        return 'sms_only';
      }
    } catch {
      // Fall through to none.
    }

    return 'none';
  }

  private static resolveApiBaseUrl(): string {
    const envBase =
      typeof process !== 'undefined' && typeof process.env.KONA_API_BASE_URL === 'string'
        ? process.env.KONA_API_BASE_URL.trim()
        : '';
    return envBase || 'http://localhost:3000';
  }

  static async resolveDeviceSecret(): Promise<string> {
    // Preferred path: secure on-device key store.
    const secureStore = this.tryRequire<{ getItemAsync: (key: string) => Promise<string | null> }>(
      'expo-secure-store',
    );

    if (secureStore && typeof secureStore.getItemAsync === 'function') {
      const stored = await secureStore.getItemAsync('KONA_DEVICE_SECRET');
      if (typeof stored === 'string' && stored.trim().length > 0) {
        return stored.trim();
      }
    }

    // Fallback path for hosted or managed environments.
    const envSecret =
      typeof process !== 'undefined' && typeof process.env.KONA_DEVICE_SECRET === 'string'
        ? process.env.KONA_DEVICE_SECRET.trim()
        : '';
    if (envSecret) {
      return envSecret;
    }

    throw new Error(
      '[StateCoordinator] Missing device secret. Configure secure storage key KONA_DEVICE_SECRET or provide StateCoordinator.configure({ getDeviceSecret }).',
    );
  }

  private static tryRequire<T>(moduleId: string): T | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const req = Function('return require')() as (id: string) => T;
      return req(moduleId);
    } catch {
      return null;
    }
  }
}
