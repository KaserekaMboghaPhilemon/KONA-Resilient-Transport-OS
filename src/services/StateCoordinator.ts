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
  runOutboundSync: (tripId: string) => Promise<void>;
  haltOutboundTransports: () => void | Promise<void>;
}

const DEFAULT_VERIFY_TABLE = 'pending_sync_queue';

function createDefaultDependencies(): StateCoordinatorDependencies {
  return {
    getLedgerDatabase: async () => {
      const { SQLiteSyncRepository } = await import('./SQLiteSyncRepository');
      return SQLiteSyncRepository.initialize();
    },
    getDeviceSecret: async () => {
      throw new Error(
        '[StateCoordinator] Missing device secret provider. Call StateCoordinator.configure({ getDeviceSecret }).',
      );
    },
    verifyTableName: DEFAULT_VERIFY_TABLE,
    runOutboundSync: async (tripId: string) => {
      const { TelemetrySyncManager } = await import('./TelemetrySyncManager');
      await TelemetrySyncManager.forceTelemetrySync(tripId);
    },
    haltOutboundTransports: async () => {
      // Stop periodic telemetry dispatch to ensure no more outbound transport occurs
      // after a compromised-ledger lock is raised.
      const { TelemetrySyncManager } = await import('./TelemetrySyncManager');
      TelemetrySyncManager.stopPeriodicSync();
    },
  };
}

export class StateCoordinator {
  private static isProcessing = false;
  private static listeners = new Set<StateCoordinatorListener>();
  private static dependencies: StateCoordinatorDependencies = createDefaultDependencies();

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
        return;
      }

      this.state = {
        ...this.state,
        ledgerIntegrityOk: true,
      };
      this.emit();

      await this.dependencies.runOutboundSync(normalizedTripId);

      this.state = {
        ...this.state,
        status: 'SYNC_COMPLETED',
        successfulRuns: this.state.successfulRuns + 1,
      };
      this.emit();
    } catch (error) {
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
   * Test helper: restores static coordinator state and default dependencies.
   */
  public static __resetForTesting(): void {
    this.isProcessing = false;
    this.listeners.clear();
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
}
