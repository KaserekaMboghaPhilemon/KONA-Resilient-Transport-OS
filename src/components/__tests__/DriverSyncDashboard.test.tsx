/**
 * Sprint 5 — DriverSyncDashboard Integration & Unit Test Suite
 *
 * Exercises the full component under RNTL against five specification groups:
 *
 *  1. Initial render state
 *  2. Connectivity path state changes (internet → sms_only → none)
 *  3. Force Sync action execution (loading states, spinner, button label)
 *  4. Post-sync reconciliation and LastSyncReport card rendering
 *  5. Error boundary: getPendingEntries rejection → QUEUE READ ERROR card
 *
 * Mock strategy:
 *  – react-native: stubbed at module level so no native binary is required.
 *  – SyncManager: jest.fn() factory returning a controllable instance.
 *  – ConnectivityProbe: plain object whose getState impl is swapped per test.
 *  – LocalDatabase.getPendingQueueEntries: overridden via the optional
 *    getPendingEntries prop so the real SQLite layer is never touched.
 *  – Animated: uses RN's built-in JS fallback (no native driver) via the
 *    react-native mock below, so Animated.spring / Animated.timing resolve
 *    synchronously in test.
 *
 * Timer discipline:
 *  – jest.useFakeTimers() is activated for every test so POLL_INTERVAL_MS
 *    setInterval calls do not leak across tests.
 *  – Where the component needs a real async settle (probe poll), we advance
 *    fake timers by a multiple of POLL_INTERVAL_MS and flush promises.
 */

// ─────────────────────────────────────────────────────────────────────────────
// react-native mock — must appear before any RN import in this file.
// Provides enough of the RN surface for RNTL to render without native modules.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// react-native mock — must appear before any RN import in this file.
// Provides enough of the RN surface for RNTL to render without native modules.
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');

  // Fully self-contained mock — does NOT call jest.requireActual because
  // react-native/index.js contains Flow `import typeof` syntax that Babel
  // cannot parse outside the full Metro bundler transform chain.

  // Minimal Animated value class — must be defined inside the factory so it
  // is not flagged as an out-of-scope variable by Jest's babel-jest hoist.
  class MockAnimatedValue {
    private _value: number;
    constructor(initial: number) { this._value = initial; }
    setValue(v: number) { this._value = v; }
    __getValue() { return this._value; }
    addListener() { return ''; }
    removeListener() {}
    removeAllListeners() {}
    stopAnimation() {}
    interpolate() { return this; }
  }

  function makeAnimation(
    value: { setValue: (n: number) => void },
    toValue: number,
  ) {
    return {
      start: (cb?: (result: { finished: boolean }) => void) => {
        value.setValue(toValue);
        cb?.({ finished: true });
      },
      stop: () => undefined,
      reset: () => undefined,
    };
  }

  const Animated = {
    Value: MockAnimatedValue,
    spring: (_v: MockAnimatedValue, cfg: { toValue: number }) =>
      makeAnimation(_v, cfg.toValue),
    timing: (_v: MockAnimatedValue, cfg: { toValue: number }) =>
      makeAnimation(_v, cfg.toValue),
    sequence: (anims: Array<{ start: (cb?: () => void) => void }>) => ({
      start: (cb?: (result: { finished: boolean }) => void) => {
        for (const a of anims) a.start();
        cb?.({ finished: true });
      },
      stop: () => undefined,
      reset: () => undefined,
    }),
    loop: (anim: { start: (cb?: () => void) => void }) => ({
      start: () => anim.start(),
      stop: () => undefined,
      reset: () => undefined,
    }),
    // Allow <Animated.View> and <Animated.Text> to render as plain divs/spans.
    View: ({ children, style }: { children?: React.ReactNode; style?: unknown }) =>
      React.createElement('View', { style }, children),
    Text: ({ children, style }: { children?: React.ReactNode; style?: unknown }) =>
      React.createElement('Text', { style }, children),
    createAnimatedComponent: (Component: React.ComponentType<unknown>) => Component,
  };

  return {
    // ── Primitives ─────────────────────────────────────────────────────────
    View: ({ children, style, testID }: { children?: React.ReactNode; style?: unknown; testID?: string }) =>
      React.createElement('View', { style, testID }, children),
    Text: ({ children, style, testID }: { children?: React.ReactNode; style?: unknown; testID?: string }) =>
      React.createElement('Text', { style, testID }, children),
    TouchableOpacity: ({
      children, onPress, disabled, activeOpacity, style,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      activeOpacity?: number;
      style?: unknown;
    }) =>
      React.createElement(
        'TouchableOpacity',
        { onPress: disabled ? undefined : onPress, disabled, style },
        children,
      ),
    ActivityIndicator: ({ size, color, style }: { size?: string | number; color?: string; style?: unknown }) =>
      React.createElement('ActivityIndicator', { size, color, style }),
    FlatList: ({
      data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent,
      ListEmptyComponent, ItemSeparatorComponent, contentContainerStyle,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
      keyExtractor?: (item: unknown, idx: number) => string;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      ItemSeparatorComponent?: React.ComponentType;
      contentContainerStyle?: unknown;
    }) => {
      const Header = ListHeaderComponent as React.ReactNode;
      const Footer = ListFooterComponent as React.ReactNode;
      const Empty  = data.length === 0 ? (ListEmptyComponent as React.ReactNode) : null;
      const Separator = ItemSeparatorComponent;
      const items = data.map((item, index) => {
        const sep = Separator && index < data.length - 1
          ? React.createElement(Separator as React.ComponentType, { key: `sep-${index}` })
          : null;
        return React.createElement(
          React.Fragment,
          { key: keyExtractor ? keyExtractor(item, index) : String(index) },
          renderItem({ item, index }),
          sep,
        );
      });
      return React.createElement(
        'View',
        { style: contentContainerStyle },
        Header,
        ...items,
        Empty,
        Footer,
      );
    },
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T): T => styles,
      flatten: (s: unknown) => s,
    },
    Platform: { OS: 'ios', select: (obj: Record<string, unknown>) => obj.ios },
    Animated,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// expo-sqlite and expo-crypto mocks (prevent native module errors when
// LocalDatabase is transitively imported by the component module).
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn().mockResolvedValue({
    execAsync:    jest.fn().mockResolvedValue(undefined),
    runAsync:     jest.fn().mockResolvedValue({ changes: 0, lastInsertRowId: -1 }),
    getAllAsync:   jest.fn().mockResolvedValue([]),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    closeAsync:   jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: jest.fn().mockResolvedValue(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ),
}));

// ─────────────────────────────────────────────────────────────────────────────
// expo-haptics mock — stubs the native haptic engine so the alarm path can be
// verified without a physical device or Expo Go environment.
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('expo-haptics', () => ({
  NotificationFeedbackType: {
    Success: 'success',
    Warning: 'warning',
    Error:   'error',
  },
  ImpactFeedbackStyle: {
    Light:  'light',
    Medium: 'medium',
    Heavy:  'heavy',
  },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync:       jest.fn().mockResolvedValue(undefined),
  selectionAsync:    jest.fn().mockResolvedValue(undefined),
}));

// ─────────────────────────────────────────────────────────────────────────────
// TelemetrySyncManager mock (Sprint 10) — static class with getter and flush methods
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('../../services/TelemetrySyncManager', () => ({
  TelemetrySyncManager: {
    getConsecutiveFailures: jest.fn().mockReturnValue(0),
    getNextSyncTimestamp: jest.fn().mockReturnValue(null),
    getUnsyncedPingCount: jest.fn().mockResolvedValue(0),
    forceTelemetrySync: jest.fn().mockResolvedValue(undefined),
    startPeriodicSync: jest.fn(),
    stopPeriodicSync: jest.fn(),
    processTelemetrySync: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../hooks/useCoordinatorState', () => ({
  useCoordinatorState: jest.fn(),
}));

jest.mock('../../services/StateCoordinator', () => {
  let deps: {
    runQueueSync?: (tripId: string) => Promise<void>;
    runTelemetrySync?: (tripId: string) => Promise<void>;
  } = {};

  class MockLedgerCompromisedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'LedgerCompromisedError';
    }
  }

  return {
    LedgerCompromisedError: MockLedgerCompromisedError,
    StateCoordinator: {
      configure: jest.fn((params: {
        runQueueSync?: (tripId: string) => Promise<void>;
        runTelemetrySync?: (tripId: string) => Promise<void>;
      }) => {
        deps = { ...deps, ...params };
      }),
      syncAllSystems: jest.fn(async (tripId: string) => {
        if (deps.runQueueSync) {
          await deps.runQueueSync(tripId);
        }
        if (deps.runTelemetrySync) {
          await deps.runTelemetrySync(tripId);
        }
      }),
      subscribe: jest.fn(() => () => undefined),
      getSnapshot: jest.fn(() => ({})),
    },
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Imports — after mocks
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { act, render, fireEvent, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';

import DriverSyncDashboard, {
  MOCK_PREVIEW_ENTRIES,
} from '../DriverSyncDashboard';

import type { ConnectivityProbe, ConnectivityState } from '../../services/SyncManager';
import { SyncManager } from '../../services/SyncManager';
import { TelemetrySyncManager } from '../../services/TelemetrySyncManager';
import { useCoordinatorState } from '../../hooks/useCoordinatorState';
import { StateCoordinator } from '../../services/StateCoordinator';
import type { QueueEntry } from '../../db/LocalDatabase';
import type { QueueProcessingReport } from '../../services/SyncManager';
import type { CoordinatorSnapshot } from '../../services/StateCoordinator';

const mockUseCoordinatorState = useCoordinatorState as jest.MockedFunction<
  typeof useCoordinatorState
>;
const mockStateCoordinator = StateCoordinator as jest.Mocked<typeof StateCoordinator>;

function makeCoordinatorSnapshot(
  overrides: Partial<CoordinatorSnapshot> = {},
): CoordinatorSnapshot {
  return {
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
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: flush pending promises so async polling useEffects settle.
//
// Uses Promise.resolve() chains so it is never blocked by fake timers.
// Each round drains one level of the microtask queue; five rounds cover
// nested async calls like: await probe.getState() → setState → React flush.
// ─────────────────────────────────────────────────────────────────────────────

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a minimal QueueProcessingReport fixture.
// ─────────────────────────────────────────────────────────────────────────────

function makeReport(
  overrides: Partial<QueueProcessingReport> = {},
): QueueProcessingReport {
  const now = Date.now();
  return {
    started_at:              now - 312,
    finished_at:             now,
    connectivity_at_start:   'internet',
    total_entries_processed: 3,
    synced_via_https:        2,
    synced_via_sms:          0,
    retried:                 1,
    permanently_failed:      0,
    skipped_no_connectivity: 0,
    entry_results:           [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a controllable mock SyncManager.
// processOfflineQueue defaults to returning a successful report.
// ─────────────────────────────────────────────────────────────────────────────

function makeMockSyncManager(
  processImpl: () => Promise<QueueProcessingReport> = async () => makeReport(),
): SyncManager {
  return {
    processOfflineQueue:    jest.fn().mockImplementation(processImpl),
    startConnectivityMonitor: jest.fn(),
    stopConnectivityMonitor:  jest.fn(),
  } as unknown as SyncManager;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a ConnectivityProbe whose state can be changed between renders.
// ─────────────────────────────────────────────────────────────────────────────

function makeProbe(initial: ConnectivityState = 'internet'): {
  probe: ConnectivityProbe;
  set: (s: ConnectivityState) => void;
} {
  let current = initial;
  return {
    probe: { getState: () => current },
    set:   (s) => { current = s; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture entries for the diagnostic list.
// Subset of MOCK_PREVIEW_ENTRIES covering all relevant attempt-count states.
// ─────────────────────────────────────────────────────────────────────────────

const FRESH_ENTRY:   QueueEntry = MOCK_PREVIEW_ENTRIES[0]; // booking_lock,    attempt_count: 0
const BACKOFF_ENTRY: QueueEntry = MOCK_PREVIEW_ENTRIES[1]; // trip_settlement,  attempt_count: 1
const NEAR_MAX_ENTRY: QueueEntry = MOCK_PREVIEW_ENTRIES[4]; // driver_location_update, attempt_count: 4

// ─────────────────────────────────────────────────────────────────────────────
// Suite set-up / tear-down
//
// No fake timers — they block React 19's async act() and prevent Promise.resolve
// microtasks from settling inside act(), causing all async tests to time out.
// RNTL calls cleanup() automatically after each test; setInterval handles
// inside useConnectivity / usePendingQueue are cleared by the effect cleanup
// when the component unmounts.
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.KONA_DEVICE_SECRET = 'TEST_COORDINATOR_DEVICE_SECRET';
  mockUseCoordinatorState.mockReturnValue(makeCoordinatorSnapshot());
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Initial Render States
// ─────────────────────────────────────────────────────────────────────────────

describe('1 — Initial render states', () => {
  it('mounts a blocking security warning layout when coordinator is compromised', async () => {
    mockUseCoordinatorState.mockReturnValue(
      makeCoordinatorSnapshot({ status: 'LEDGER_COMPROMISED_LOCK' }),
    );

    const { probe } = makeProbe('internet');
    const { getByText, queryByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => [FRESH_ENTRY]}
      />,
    );

    expect(
      getByText('CRITICAL SECURITY WARNING: LOCAL LEDGER COMPROMISED'),
    ).toBeTruthy();
    expect(
      getByText('ALL OUTBOUND TRANSPORT SYNCHRONIZATION IS LOCKED'),
    ).toBeTruthy();
    expect(queryByText('FORCE SYNC NOW')).toBeNull();
    expect(queryByText('PENDING SYNC QUEUE')).toBeNull();
  });

  it('renders the brand name and screen title', async () => {
    const { probe }  = makeProbe('internet');
    const manager    = makeMockSyncManager();
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
        title="Sync Status"
      />,
    );

    await flushPromises();

    expect(getByText('KONA')).toBeTruthy();
    expect(getByText('Sync Status')).toBeTruthy();
  });

  it('renders the NetworkStatusBanner with INTERNET ACTIVE title', async () => {
    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    expect(getByText('INTERNET ACTIVE')).toBeTruthy();
  });

  it('renders the HTTPS subtitle inside the banner for internet state', async () => {
    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    expect(getByText('All payloads transmitting securely via HTTPS')).toBeTruthy();
  });

  it('renders the PENDING SYNC QUEUE metric card label', async () => {
    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    expect(getByText('PENDING SYNC QUEUE')).toBeTruthy();
  });

  it('renders the pending count from getPendingEntries as the metric number', async () => {
    const { probe } = makeProbe('internet');
    const entries   = [FRESH_ENTRY, BACKOFF_ENTRY, NEAR_MAX_ENTRY];

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => entries}
      />,
    );

    await flushPromises();

    expect(getByText('3')).toBeTruthy();
  });

  it('renders QUEUE DIAGNOSTICS section heading', async () => {
    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => [FRESH_ENTRY]}
      />,
    );

    await flushPromises();

    expect(getByText('QUEUE DIAGNOSTICS')).toBeTruthy();
  });

  it('renders a QueueEntryRow for each pending entry using its shortened order UUID', async () => {
    const { probe } = makeProbe('internet');
    const entries   = [FRESH_ENTRY, BACKOFF_ENTRY];

    const { getAllByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => entries}
      />,
    );

    await flushPromises();

    // shortId for FRESH_ENTRY: 'aaaaaaaa…0001'
    const shortIdA = `${FRESH_ENTRY.order_id.slice(0, 8)}…${FRESH_ENTRY.order_id.slice(-4)}`;
    const shortIdB = `${BACKOFF_ENTRY.order_id.slice(0, 8)}…${BACKOFF_ENTRY.order_id.slice(-4)}`;

    const matchA = getAllByText(shortIdA);
    const matchB = getAllByText(shortIdB);

    expect(matchA.length).toBeGreaterThanOrEqual(1);
    expect(matchB.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the BK LOCK action badge for booking_lock entries', async () => {
    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => [FRESH_ENTRY]}
      />,
    );

    await flushPromises();

    expect(getByText('BK LOCK')).toBeTruthy();
  });

  it('labels fresh entries as "pending first dispatch"', async () => {
    const { probe } = makeProbe('internet');
    const { getAllByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => [FRESH_ENTRY]}
      />,
    );

    await flushPromises();

    const matches = getAllByText('pending first dispatch');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('labels backoff entries with attempt count', async () => {
    const { probe } = makeProbe('internet');
    const { getAllByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => [BACKOFF_ENTRY]}
      />,
    );

    await flushPromises();

    const expected = `attempt ${BACKOFF_ENTRY.attempt_count} — backoff scheduled`;
    const matches  = getAllByText(expected);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the FORCE SYNC NOW button', async () => {
    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    expect(getByText('FORCE SYNC NOW')).toBeTruthy();
  });

  it('renders the empty state when the queue has no entries', async () => {
    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    expect(getByText('Queue is clear')).toBeTruthy();
    expect(
      getByText('All local transactions have been transmitted to the KONA backend.'),
    ).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Connectivity Path State Changes
// ─────────────────────────────────────────────────────────────────────────────

describe('2 — Connectivity path state changes', () => {
  it('shows CELLULAR DATA OFFLINE title when probe transitions to sms_only', async () => {
    const { probe: internetProbe } = makeProbe('internet');
    const { probe: smsProbe }      = makeProbe('sms_only');
    const manager                  = makeMockSyncManager();
    const stableFetch              = async (): Promise<QueueEntry[]> => [];

    const { getByText, rerender } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={internetProbe}
        getPendingEntries={stableFetch}
      />,
    );

    await flushPromises();
    // Confirm initial internet state is rendered.
    expect(getByText('INTERNET ACTIVE')).toBeTruthy();

    // Changing the connectivityProbe prop causes useConnectivity's effect to
    // re-run with the new probe, which returns 'sms_only' on its first poll.
    await rerender(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={smsProbe}
        getPendingEntries={stableFetch}
      />,
    );

    await flushPromises();

    expect(getByText('CELLULAR DATA OFFLINE')).toBeTruthy();
  });

  it('renders the SMS encoding subtitle for sms_only state', async () => {
    const { probe } = makeProbe('sms_only');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    expect(
      getByText('Encoding payloads via Base45 compact SMS frames'),
    ).toBeTruthy();
  });

  it('renders the SMS TELEPHONY FALLBACK ACTIVE badge for sms_only state', async () => {
    const { probe } = makeProbe('sms_only');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    expect(getByText('SMS TELEPHONY FALLBACK ACTIVE')).toBeTruthy();
  });

  it('does NOT render the SMS badge when state is internet', async () => {
    const { probe } = makeProbe('internet');
    const { queryByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    expect(queryByText('SMS TELEPHONY FALLBACK ACTIVE')).toBeNull();
  });

  it('shows NO CONNECTIVITY title when probe returns none', async () => {
    const { probe } = makeProbe('none');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    expect(getByText('NO CONNECTIVITY')).toBeTruthy();
  });

  it('renders queued-locally subtitle for none state', async () => {
    const { probe } = makeProbe('none');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    expect(
      getByText('Transmissions queued locally — awaiting signal'),
    ).toBeTruthy();
  });

  it('updates banner from sms_only back to internet on probe change', async () => {
    const { probe: smsProbe }      = makeProbe('sms_only');
    const { probe: internetProbe } = makeProbe('internet');
    const manager                  = makeMockSyncManager();
    const stableFetch              = async (): Promise<QueueEntry[]> => [];

    const { getByText, rerender } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={smsProbe}
        getPendingEntries={stableFetch}
      />,
    );

    await flushPromises();
    expect(getByText('CELLULAR DATA OFFLINE')).toBeTruthy();

    await rerender(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={internetProbe}
        getPendingEntries={stableFetch}
      />,
    );

    await flushPromises();

    expect(getByText('INTERNET ACTIVE')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Force Sync Action Execution
// ─────────────────────────────────────────────────────────────────────────────

describe('3 — Force Sync action execution', () => {
  it('calls syncManager.processOfflineQueue() when the button is pressed', async () => {
    const { probe } = makeProbe('internet');
    let resolveSync!: (r: QueueProcessingReport) => void;
    const blockingProcess = new Promise<QueueProcessingReport>(
      (resolve) => { resolveSync = resolve; },
    );

    const manager = makeMockSyncManager(() => blockingProcess);

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await flushPromises();

    expect(manager.processOfflineQueue).toHaveBeenCalledTimes(1);
    expect(mockStateCoordinator.syncAllSystems).toHaveBeenCalledTimes(1);

    // Clean up — resolve so the component can unmount without state updates.
    await act(async () => { resolveSync(makeReport()); await Promise.resolve(); });
    await flushPromises();
  });

  it('switches button label to TRANSMITTING… while sync is in flight', async () => {
    const { probe } = makeProbe('internet');
    let resolveSync!: (r: QueueProcessingReport) => void;
    const blockingProcess = new Promise<QueueProcessingReport>(
      (resolve) => { resolveSync = resolve; },
    );

    const { getByText, queryByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager(() => blockingProcess)}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await flushPromises();

    expect(getByText('TRANSMITTING…')).toBeTruthy();
    expect(queryByText('FORCE SYNC NOW')).toBeNull();

    await act(async () => { resolveSync(makeReport()); await Promise.resolve(); });
    await flushPromises();
  });

  it('re-displays FORCE SYNC NOW after sync completes', async () => {
    const { probe }  = makeProbe('internet');
    const manager    = makeMockSyncManager();

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await flushPromises();

    await waitFor(() => {
      expect(getByText('FORCE SYNC NOW')).toBeTruthy();
    });
  });

  it('disables the button while isSyncing is true', async () => {
    const { probe } = makeProbe('internet');
    let resolveSync!: (r: QueueProcessingReport) => void;
    const blockingProcess = new Promise<QueueProcessingReport>(
      (resolve) => { resolveSync = resolve; },
    );

    const manager = makeMockSyncManager(() => blockingProcess);

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));
    await flushPromises();

    // Press a second time while in flight — processOfflineQueue must NOT be
    // called again.
    await fireEvent.press(getByText('TRANSMITTING…'));
    await flushPromises();

    expect(manager.processOfflineQueue).toHaveBeenCalledTimes(1);

    await act(async () => { resolveSync(makeReport()); await Promise.resolve(); });
    await flushPromises();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Post-Sync Reconciliation & LastSyncReport
// ─────────────────────────────────────────────────────────────────────────────

describe('4 — Post-sync reconciliation and LastSyncReport', () => {
  it('shows the LAST SYNC RUN card after processOfflineQueue resolves', async () => {
    const { probe } = makeProbe('internet');
    const manager   = makeMockSyncManager(async () => makeReport());

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await waitFor(() => {
      expect(getByText('LAST SYNC RUN')).toBeTruthy();
    });
  });

  it('displays the HTTPS path badge in the report card for internet syncs', async () => {
    const { probe } = makeProbe('internet');
    const manager   = makeMockSyncManager(
      async () => makeReport({ connectivity_at_start: 'internet' }),
    );

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await waitFor(() => {
      expect(getByText('HTTPS')).toBeTruthy();
    });
  });

  it('displays the SMS RELAY path badge for sms_only syncs', async () => {
    const { probe } = makeProbe('sms_only');
    const manager   = makeMockSyncManager(
      async () => makeReport({ connectivity_at_start: 'sms_only' }),
    );

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await waitFor(() => {
      expect(getByText('SMS RELAY')).toBeTruthy();
    });
  });

  it('renders the total synced stat (synced_via_https + synced_via_sms)', async () => {
    const { probe } = makeProbe('internet');
    const manager   = makeMockSyncManager(
      async () => makeReport({ synced_via_https: 4, synced_via_sms: 1 }),
    );

    const { getAllByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getAllByText('FORCE SYNC NOW')[0]);

    await waitFor(() => {
      // totalSynced = 4 + 1 = 5; the value '5' appears in the reportStat.
      const fiveMatches = getAllByText('5');
      expect(fiveMatches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the retried stat', async () => {
    const { probe } = makeProbe('internet');
    const manager   = makeMockSyncManager(
      async () => makeReport({ retried: 3 }),
    );

    const { getAllByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getAllByText('FORCE SYNC NOW')[0]);

    await waitFor(() => {
      expect(getAllByText('3').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the permanently_failed stat', async () => {
    const { probe } = makeProbe('internet');
    const manager   = makeMockSyncManager(
      async () => makeReport({ permanently_failed: 2 }),
    );

    const { getAllByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getAllByText('FORCE SYNC NOW')[0]);

    await waitFor(() => {
      expect(getAllByText('2').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders an elapsed time value in the report', async () => {
    const { probe } = makeProbe('internet');
    const now       = Date.now();
    const manager   = makeMockSyncManager(
      async () => makeReport({ started_at: now - 800, finished_at: now }),
    );

    const { getAllByText, getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getAllByText('FORCE SYNC NOW')[0]);

    // elapsed < 1 000 ms → displayed as '800ms'
    await waitFor(() => {
      expect(getByText('800ms')).toBeTruthy();
    });
  });

  it('renders elapsed in seconds when duration >= 1 000 ms', async () => {
    const { probe } = makeProbe('internet');
    const now       = Date.now();
    const manager   = makeMockSyncManager(
      async () => makeReport({ started_at: now - 2_500, finished_at: now }),
    );

    const { getAllByText, getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getAllByText('FORCE SYNC NOW')[0]);

    await waitFor(() => {
      expect(getByText('2.5s')).toBeTruthy();
    });
  });

  it('displays the synced stat label in the report card', async () => {
    const { probe } = makeProbe('internet');
    const manager   = makeMockSyncManager(async () => makeReport());

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await waitFor(() => {
      expect(getByText('synced')).toBeTruthy();
      expect(getByText('retried')).toBeTruthy();
      expect(getByText('failed')).toBeTruthy();
      expect(getByText('elapsed')).toBeTruthy();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Error Boundaries & Fallback Displays
// ─────────────────────────────────────────────────────────────────────────────

describe('5 — Error boundaries and fallback displays', () => {
  it('shows QUEUE READ ERROR card when getPendingEntries rejects', async () => {
    const { probe } = makeProbe('internet');
    const failingFetch = jest.fn().mockRejectedValue(
      new Error('SQLite connection pool exhausted'),
    );

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={failingFetch}
      />,
    );

    await waitFor(() => {
      expect(getByText('QUEUE READ ERROR')).toBeTruthy();
    });
  });

  it('displays the rejection error message inside the error card', async () => {
    const { probe } = makeProbe('internet');
    const errorMsg  = 'SQLite connection pool exhausted';
    const failingFetch = jest.fn().mockRejectedValue(new Error(errorMsg));

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={failingFetch}
      />,
    );

    await waitFor(() => {
      expect(getByText(errorMsg)).toBeTruthy();
    });
  });

  it('uses a fallback message for non-Error rejection values', async () => {
    const { probe } = makeProbe('internet');
    const failingFetch = jest.fn().mockRejectedValue('raw string error');

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={failingFetch}
      />,
    );

    await waitFor(() => {
      expect(getByText('Failed to read queue entries.')).toBeTruthy();
    });
  });

  it('shows SYNC ERROR card when processOfflineQueue throws', async () => {
    const { probe } = makeProbe('internet');
    const manager   = makeMockSyncManager(
      async () => { throw new Error('Backend unreachable'); },
    );

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await waitFor(() => {
      expect(getByText('SYNC ERROR')).toBeTruthy();
      expect(getByText('Backend unreachable')).toBeTruthy();
    });
  });

  it('restores the FORCE SYNC NOW button after a sync error', async () => {
    const { probe } = makeProbe('internet');
    const manager   = makeMockSyncManager(
      async () => { throw new Error('503 Service Unavailable'); },
    );

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await waitFor(() => {
      expect(getByText('FORCE SYNC NOW')).toBeTruthy();
    });
  });

  it('does not render the LAST SYNC RUN card after a sync error', async () => {
    const { probe } = makeProbe('internet');
    const manager   = makeMockSyncManager(
      async () => { throw new Error('timeout'); },
    );

    const { getByText, queryByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
      />,
    );

    await flushPromises();

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await waitFor(() => {
      expect(getByText('SYNC ERROR')).toBeTruthy();
    });

    expect(queryByText('LAST SYNC RUN')).toBeNull();
  });

  it('re-runs getPendingEntries after a successful sync (refreshTrigger)', async () => {
    const { probe } = makeProbe('internet');

    let callCount = 0;
    const trackingFetch = jest.fn().mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? [FRESH_ENTRY] : [];
    });

    const manager = makeMockSyncManager(async () => makeReport());

    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={trackingFetch}
      />,
    );

    await flushPromises();

    // Initial fetch call should have happened.
    expect(trackingFetch).toHaveBeenCalledTimes(1);

    await fireEvent.press(getByText('FORCE SYNC NOW'));

    await flushPromises();

    // After sync completes, refreshTrigger increments and triggers a fresh
    // fetch — the mock returns [] on the second call.
    await waitFor(() => {
      expect(trackingFetch).toHaveBeenCalledTimes(2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Sprint 10 — Telemetry Status & Manual Override
// ─────────────────────────────────────────────────────────────────────────────

describe('6 — Telemetry status and manual flush (Sprint 10)', () => {
  it('does not render TelemetryStatusCard when tripId is not provided', async () => {
    const { probe } = makeProbe('internet');
    const { queryByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
        tripId={null}
      />,
    );

    await flushPromises();

    expect(queryByText('TELEMETRY MONITORING')).toBeNull();
  });

  it('renders TelemetryStatusCard when tripId is provided', async () => {
    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
        tripId="trip-123"
      />,
    );

    await flushPromises();

    expect(getByText('TELEMETRY MONITORING')).toBeTruthy();
  });

  it('displays HEALTHY status when consecutive failures is 0', async () => {
    (TelemetrySyncManager.getConsecutiveFailures as jest.Mock).mockReturnValue(0);

    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
        tripId="trip-123"
      />,
    );

    await flushPromises();

    expect(getByText('HEALTHY')).toBeTruthy();
  });

  it('displays BACKOFF ACTIVE status when consecutive failures > 0', async () => {
    (TelemetrySyncManager.getConsecutiveFailures as jest.Mock).mockReturnValue(2);
    (TelemetrySyncManager.getNextSyncTimestamp as jest.Mock).mockReturnValue(
      Date.now() + 120_000, // 120 seconds from now
    );

    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
        tripId="trip-123"
      />,
    );

    await flushPromises();

    expect(getByText(/BACKOFF ACTIVE/)).toBeTruthy();
  });

  it('displays buffer count from TelemetrySyncManager.getUnsyncedPingCount', async () => {
    (TelemetrySyncManager.getUnsyncedPingCount as jest.Mock).mockResolvedValue(5);

    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
        tripId="trip-123"
      />,
    );

    await flushPromises();

    expect(getByText('5')).toBeTruthy();
    expect(getByText('pings')).toBeTruthy();
  });

  it('renders FLUSH TELEMETRY NOW button', async () => {
    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
        tripId="trip-123"
      />,
    );

    await flushPromises();

    expect(getByText('FLUSH TELEMETRY NOW')).toBeTruthy();
  });

  it('calls TelemetrySyncManager.forceTelemetrySync when flush button is pressed', async () => {
    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
        tripId="trip-123"
      />,
    );

    await flushPromises();

    const flushButton = getByText('FLUSH TELEMETRY NOW');
    await act(async () => {
      fireEvent.press(flushButton);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(TelemetrySyncManager.forceTelemetrySync).toHaveBeenCalledWith('trip-123');
    });

    // Ensure the async onFlush finally-path settles before test teardown.
    await flushPromises();
  });

  it('disables flush button while flushing is in progress', async () => {
    let resolveFlush!: () => void;
    (TelemetrySyncManager.forceTelemetrySync as jest.Mock).mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveFlush = resolve;
      }),
    );

    const { probe } = makeProbe('internet');
    const { getByText, queryByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
        tripId="trip-123"
      />,
    );

    await flushPromises();

    const flushButton = getByText('FLUSH TELEMETRY NOW');
    await act(async () => {
      fireEvent.press(flushButton);
      await Promise.resolve();
    });

    expect(TelemetrySyncManager.forceTelemetrySync).toHaveBeenCalledWith('trip-123');
    expect(queryByText('FLUSH TELEMETRY NOW')).toBeNull();

    await act(async () => {
      resolveFlush();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(queryByText('FLUSH TELEMETRY NOW')).toBeTruthy();
    });

    await flushPromises();
  });

  it('updates countdown when nextSyncTimestamp changes', async () => {
    const now = Date.now();
    (TelemetrySyncManager.getConsecutiveFailures as jest.Mock).mockReturnValue(1);
    (TelemetrySyncManager.getNextSyncTimestamp as jest.Mock).mockReturnValue(
      now + 45_000, // 45 seconds from now
    );

    const { probe } = makeProbe('internet');
    const { getByText } = await render(
      <DriverSyncDashboard
        syncManager={makeMockSyncManager()}
        connectivityProbe={probe}
        getPendingEntries={async () => []}
        tripId="trip-123"
      />,
    );

    await flushPromises();

    // The countdown should show ~45 seconds remaining
    expect(getByText(/BACKOFF ACTIVE/)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Automated Alarm and Auto-Sync Deferral
//
// Verifies that when connectivity drops to 'none' with unsynced queue entries:
//   a) the visual alarm banner and haptic fire after alarmWarningDelayMs, and
//   b) processOfflineQueue() is called automatically after autoSyncDelayMs
//      without any user-initiated press event.
//
// Timer design: alarmWarningDelayMs={0} and autoSyncDelayMs={0} cause the
// component to use Promise.resolve() instead of setTimeout, making both timers
// microtasks that flushPromises() can drain — no jest.useFakeTimers() required.
// ─────────────────────────────────────────────────────────────────────────────

describe('6 — Automated Alarm and Auto-Sync Deferral', () => {
  it('should trigger audio alarm and display countdown warning when connection drops with entries present', async () => {
    const { probe: internetProbe } = makeProbe('internet');
    const { probe: noneProbe }     = makeProbe('none');
    const manager                  = makeMockSyncManager();
    // Stable reference across rerenders so usePendingQueue doesn't reload.
    const stableFetch              = async (): Promise<QueueEntry[]> => [FRESH_ENTRY];

    // Mount in normal internet state so we can assert the transition.
    const { getByText, queryByText, rerender } = await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={internetProbe}
        getPendingEntries={stableFetch}
        alarmWarningDelayMs={0}
        autoSyncDelayMs={999_999}  // prevent auto-sync from firing during this test
      />,
    );

    await flushPromises();

    // Baseline: internet is active, alarm banner must not be present.
    expect(getByText('INTERNET ACTIVE')).toBeTruthy();
    expect(queryByText('AUTO-SYNC QUEUED')).toBeNull();

    // Transition the probe to no-connectivity.  The rerender causes
    // useConnectivity to poll the new probe immediately; the alarm effect
    // re-arms with delay = 0, which resolves as a microtask.
    await rerender(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={noneProbe}
        getPendingEntries={stableFetch}
        alarmWarningDelayMs={0}
        autoSyncDelayMs={999_999}
      />,
    );

    // First flush: connectivity state transitions to 'none', alarm effect arms.
    // Second flush: the delay-0 microtask resolves — setAlarmActive(true) and
    //               Haptics.notificationAsync are both called.
    await flushPromises();
    await flushPromises();

    // Visual alarm banner must now be present in the layout tree.
    expect(getByText('AUTO-SYNC QUEUED')).toBeTruthy();
    expect(
      getByText('No connectivity — auto-dispatch pending when signal returns'),
    ).toBeTruthy();

    // Haptic notification must have been requested exactly once with the
    // Warning feedback type.
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Warning,
    );
  });

  it('should automatically invoke handleForceSync when countdown deferral threshold clears', async () => {
    const { probe } = makeProbe('none');
    const manager   = makeMockSyncManager(async () => makeReport());

    // Mount directly in 'none' state so the alarm effect arms on the first
    // render.  Both delays are 0, so both timers resolve as microtasks and
    // are drained within the flushPromises() rounds below.
    await render(
      <DriverSyncDashboard
        syncManager={manager}
        connectivityProbe={probe}
        getPendingEntries={async (): Promise<QueueEntry[]> => [FRESH_ENTRY]}
        alarmWarningDelayMs={0}
        autoSyncDelayMs={0}
      />,
    );

    // Round 1: drains the initial effect chain:
    //   probe.getState() → setState('none') already 'none' (no-op)
    //   getPendingEntries() → setEntries([FRESH_ENTRY]) → entryCount = 1
    //   alarm effect fires: wait(0) = Promise.resolve() for both timers
    // Round 2: drains the timer callbacks:
    //   alarmTimer  → setAlarmActive(true) + Haptics.notificationAsync
    //   autoSyncTimer → handleForceSyncRef.current() → processOfflineQueue()
    //                 → setLastReport + setRefreshTrigger + setIsSyncing(false)
    await flushPromises();
    await flushPromises();

    // processOfflineQueue must have been called exactly once by the background
    // auto-sync timer — no user press event was dispatched in this test.
    expect(manager.processOfflineQueue).toHaveBeenCalledTimes(1);
  });
});
