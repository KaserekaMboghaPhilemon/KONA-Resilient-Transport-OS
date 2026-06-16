/**
 * Sprint 5 — Driver Sync Dashboard
 *
 * Minimalist, high-end mobile screen component for KONA driver clients.
 * Surfaces live SyncManager state through three integrated layers:
 *
 *  1. NetworkStatusBanner  — connectivity path with SMS fallback badge.
 *  2. QueueMetricCard      — pending queue depth with fresh/backoff split.
 *  3. Queue diagnostic list — per-entry action type, attempt count, state dot.
 *  4. ForceSyncButton      — calls processOfflineQueue() with spring animation.
 *  5. LastSyncReport       — stats from the most recent completed run.
 *
 * Architecture:
 *  – connectivityProbe polled every POLL_INTERVAL_MS via useConnectivity().
 *  – getPendingEntries polled on same cadence; re-fetches immediately after
 *    every manual sync via a refreshTrigger counter.
 *  – All callbacks memoised. FlatList uses stable renderItem + keyExtractor
 *    references to stay within the 16 ms frame budget on rapid state changes.
 *  – Zero external UI library dependencies — react-native core primitives only.
 *
 * Peer dependencies (already in package.json):
 *  react, react-native (via expo)
 *  ../services/SyncManager (Sprint 4)
 *  ../db/LocalDatabase    (Sprint 2)
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  ListRenderItemInfo,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type {
  ConnectivityProbe,
  ConnectivityState,
  QueueProcessingReport,
} from '../services/SyncManager';
import { SyncManager } from '../services/SyncManager';

import type { QueueEntry, OfflineActionType } from '../db/LocalDatabase';
import { getPendingQueueEntries } from '../db/LocalDatabase';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Connectivity and queue polling cadence in milliseconds. */
const POLL_INTERVAL_MS = 4_000;

/**
 * attempt_count threshold at which an entry is displayed as being in a
 * temporary backoff state rather than a clean first-queued state.
 */
const BACKOFF_THRESHOLD = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens
// ─────────────────────────────────────────────────────────────────────────────

const PALETTE = {
  // Surfaces
  bg:            '#0D1117',
  surface:       '#161B22',
  surfaceAlt:    '#1C2128',
  border:        '#21262D',
  // Text
  textPrimary:   '#E6EDF3',
  textSecondary: '#8B949E',
  textTertiary:  '#484F58',
  // Emerald — online / success
  emerald:       '#10B981',
  emeraldDim:    '#052E16',
  emeraldAccent: '#34D399',
  // Amber — SMS fallback / backoff
  amber:         '#F59E0B',
  amberDim:      '#451A03',
  amberAccent:   '#FCD34D',
  // Slate — no connectivity
  slate:         '#475569',
  slateDim:      '#0F172A',
  slateAccent:   '#94A3B8',
  // Semantic
  red:           '#EF4444',
  redDim:        '#450A0A',
  blue:          '#3B82F6',
  blueDim:       '#1E3A5F',
  blueAccent:    '#60A5FA',
  purple:        '#8B5CF6',
  purpleDim:     '#2E1065',
  purpleAccent:  '#A78BFA',
  teal:          '#14B8A6',
  tealDim:       '#042F2E',
  tealAccent:    '#2DD4BF',
  orange:        '#F97316',
  orangeDim:     '#431407',
  orangeAccent:  '#FB923C',
} as const;

const RADIUS  = { sm: 6,  md: 10, lg: 14, xl: 18 } as const;
const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Action-type display configuration
// ─────────────────────────────────────────────────────────────────────────────

type ActionConfig = { label: string; color: string; dimColor: string };

const ACTION_CONFIG: Record<OfflineActionType, ActionConfig> = {
  booking_lock:            { label: 'BK LOCK', color: PALETTE.emerald,      dimColor: PALETTE.emeraldDim  },
  booking_reversal:        { label: 'BK REV',  color: PALETTE.amber,        dimColor: PALETTE.amberDim    },
  trip_settlement:         { label: 'SETTLE',  color: PALETTE.blueAccent,   dimColor: PALETTE.blueDim     },
  order_status_update:     { label: 'STATUS',  color: PALETTE.purpleAccent, dimColor: PALETTE.purpleDim   },
  driver_location_update:  { label: 'LOCTN',   color: PALETTE.tealAccent,   dimColor: PALETTE.tealDim     },
  dispatch_offer_response: { label: 'OFFER',   color: PALETTE.orangeAccent, dimColor: PALETTE.orangeDim   },
};

function getActionConfig(actionType: string): ActionConfig {
  return (
    ACTION_CONFIG[actionType as OfflineActionType] ?? {
      label:    actionType.slice(0, 6).toUpperCase(),
      color:    PALETTE.slateAccent,
      dimColor: PALETTE.slateDim,
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Connectivity banner display configuration
// ─────────────────────────────────────────────────────────────────────────────

type BannerConfig = {
  bgColor:     string;
  borderColor: string;
  dotColor:    string;
  title:       string;
  subtitle:    string;
  badge:       string | null;
  badgeBg:     string;
  badgeColor:  string;
  pulseDot:    boolean;
};

const BANNER_CONFIG: Record<ConnectivityState, BannerConfig> = {
  internet: {
    bgColor:     PALETTE.emeraldDim,
    borderColor: PALETTE.emerald,
    dotColor:    PALETTE.emerald,
    title:       'INTERNET ACTIVE',
    subtitle:    'All payloads transmitting securely via HTTPS',
    badge:       null,
    badgeBg:     'transparent',
    badgeColor:  'transparent',
    pulseDot:    false,
  },
  sms_only: {
    bgColor:     PALETTE.amberDim,
    borderColor: PALETTE.amber,
    dotColor:    PALETTE.amber,
    title:       'CELLULAR DATA OFFLINE',
    subtitle:    'Encoding payloads via Base45 compact SMS frames',
    badge:       'SMS TELEPHONY FALLBACK ACTIVE',
    badgeBg:     PALETTE.amber,
    badgeColor:  '#000000',
    pulseDot:    true,
  },
  none: {
    bgColor:     PALETTE.slateDim,
    borderColor: PALETTE.slate,
    dotColor:    PALETTE.slate,
    title:       'NO CONNECTIVITY',
    subtitle:    'Transmissions queued locally — awaiting signal',
    badge:       null,
    badgeBg:     'transparent',
    badgeColor:  'transparent',
    pulseDot:    true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Custom hooks
// ─────────────────────────────────────────────────────────────────────────────

/** Polls connectivityProbe.getState() at POLL_INTERVAL_MS, returning live state. */
function useConnectivity(probe: ConnectivityProbe): ConnectivityState {
  const [state, setState] = useState<ConnectivityState>('none');

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const s = await probe.getState();
        if (!cancelled) setState(s);
      } catch {
        // Non-fatal — keep last known state and retry on the next tick.
      }
    }

    void poll();
    const handle = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [probe]);

  return state;
}

type UsePendingQueueResult = {
  entries:    QueueEntry[];
  entryCount: number;
  isLoading:  boolean;
  fetchError: string | null;
};

/**
 * Polls getPendingEntries at POLL_INTERVAL_MS. When refreshTrigger increments,
 * the effect re-runs immediately so the list updates right after a force sync.
 */
function usePendingQueue(
  getPendingEntries: () => Promise<QueueEntry[]>,
  refreshTrigger:   number,
): UsePendingQueueResult {
  const [entries, setEntries]       = useState<QueueEntry[]>([]);
  const [isLoading, setIsLoading]   = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await getPendingEntries();
      setEntries(rows);
      setFetchError(null);
    } catch (err) {
      setFetchError(
        err instanceof Error ? err.message : 'Failed to read queue entries.',
      );
    } finally {
      setIsLoading(false);
    }
  }, [getPendingEntries]);

  useEffect(() => {
    setIsLoading(true);
    void load();
    const handle = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [load, refreshTrigger]);

  const entryCount = useMemo(() => entries.length, [entries]);
  return { entries, entryCount, isLoading, fetchError };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

// ── NetworkStatusBanner ───────────────────────────────────────────────────────

function NetworkStatusBanner({ state }: { state: ConnectivityState }) {
  const cfg      = BANNER_CONFIG[state];
  const dotOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (cfg.pulseDot) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(dotOpacity, { toValue: 0.25, duration: 900, useNativeDriver: true }),
          Animated.timing(dotOpacity, { toValue: 1,    duration: 900, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      dotOpacity.setValue(1);
      return undefined;
    }
  }, [cfg.pulseDot, dotOpacity]);

  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: cfg.bgColor, borderColor: cfg.borderColor },
      ]}
    >
      <View style={styles.bannerRow}>
        <Animated.View
          style={[
            styles.bannerDot,
            { backgroundColor: cfg.dotColor, opacity: dotOpacity },
          ]}
        />
        <View style={styles.bannerTextGroup}>
          <Text style={[styles.bannerTitle, { color: cfg.dotColor }]}>
            {cfg.title}
          </Text>
          <Text style={styles.bannerSubtitle}>{cfg.subtitle}</Text>
        </View>
      </View>

      {cfg.badge !== null && (
        <View style={[styles.smsBadge, { backgroundColor: cfg.badgeBg }]}>
          <Text style={[styles.smsBadgeText, { color: cfg.badgeColor }]}>
            {cfg.badge}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── QueueMetricCard ───────────────────────────────────────────────────────────

function QueueMetricCard({
  count,
  isSyncing,
  freshCount,
  retryingCount,
}: {
  count:         number;
  isSyncing:     boolean;
  freshCount:    number;
  retryingCount: number;
}) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>PENDING SYNC QUEUE</Text>

      <View style={styles.metricCountRow}>
        {isSyncing ? (
          <ActivityIndicator
            size="large"
            color={PALETTE.blue}
            style={styles.metricSpinner}
          />
        ) : (
          <Text style={styles.metricCount}>{count}</Text>
        )}
      </View>

      <Text style={styles.metricCaption}>
        {isSyncing
          ? 'Transmitting entries to KONA backend…'
          : count === 0
            ? 'All local transactions have been transmitted'
            : `${freshCount} first-queue  ·  ${retryingCount} in backoff`}
      </Text>

      {!isSyncing && count > 0 && (
        <View style={styles.metricPillRow}>
          <View style={[styles.metricPill, { backgroundColor: PALETTE.emeraldDim }]}>
            <Text style={[styles.metricPillText, { color: PALETTE.emeraldAccent }]}>
              {freshCount} FRESH
            </Text>
          </View>
          {retryingCount > 0 && (
            <View style={[styles.metricPill, { backgroundColor: PALETTE.amberDim }]}>
              <Text style={[styles.metricPillText, { color: PALETTE.amberAccent }]}>
                {retryingCount} IN BACKOFF
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// ── ActionTypeBadge ───────────────────────────────────────────────────────────

function ActionTypeBadge({ actionType }: { actionType: string }) {
  const cfg = getActionConfig(actionType);
  return (
    <View style={[styles.actionBadge, { backgroundColor: cfg.dimColor }]}>
      <Text style={[styles.actionBadgeText, { color: cfg.color }]}>
        {cfg.label}
      </Text>
    </View>
  );
}

// ── StatusIndicator ───────────────────────────────────────────────────────────

function StatusIndicator({ attemptCount }: { attemptCount: number }) {
  const isBackoff  = attemptCount >= BACKOFF_THRESHOLD;
  const dotColor   = isBackoff ? PALETTE.amber : PALETTE.emerald;
  const dotOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isBackoff) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(dotOpacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
          Animated.timing(dotOpacity, { toValue: 1,   duration: 700, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      dotOpacity.setValue(1);
      return undefined;
    }
  }, [isBackoff, dotOpacity]);

  return (
    <Animated.View
      style={[
        styles.statusDot,
        { backgroundColor: dotColor, opacity: dotOpacity },
      ]}
    />
  );
}

// ── QueueEntryRow ─────────────────────────────────────────────────────────────

function QueueEntryRow({ entry }: { entry: QueueEntry }) {
  const shortId    = `${entry.order_id.slice(0, 8)}…${entry.order_id.slice(-4)}`;
  const isBackoff  = entry.attempt_count >= BACKOFF_THRESHOLD;
  const attemptStr = isBackoff
    ? `attempt ${entry.attempt_count} — backoff scheduled`
    : 'pending first dispatch';

  return (
    <View style={styles.entryRow}>
      <ActionTypeBadge actionType={entry.action_type} />
      <View style={styles.entryMeta}>
        <Text style={styles.entryOrderId}>{shortId}</Text>
        <Text
          style={[styles.entryAttemptLabel, isBackoff && styles.entryAttemptBackoff]}
        >
          {attemptStr}
        </Text>
      </View>
      <StatusIndicator attemptCount={entry.attempt_count} />
    </View>
  );
}

// ── LastSyncReport ────────────────────────────────────────────────────────────

function LastSyncReport({ report }: { report: QueueProcessingReport }) {
  const elapsedMs = report.finished_at - report.started_at;
  const elapsed   = elapsedMs < 1_000
    ? `${elapsedMs}ms`
    : `${(elapsedMs / 1_000).toFixed(1)}s`;

  const path = report.connectivity_at_start === 'internet'
    ? 'HTTPS'
    : report.connectivity_at_start === 'sms_only'
      ? 'SMS RELAY'
      : 'NONE';

  const totalSynced = report.synced_via_https + report.synced_via_sms;

  return (
    <View style={styles.reportCard}>
      <View style={styles.reportHeader}>
        <Text style={styles.sectionLabel}>LAST SYNC RUN</Text>
        <View style={[styles.reportPathBadge, { backgroundColor: PALETTE.blueDim }]}>
          <Text style={[styles.reportPathText, { color: PALETTE.blueAccent }]}>
            {path}
          </Text>
        </View>
      </View>

      <View style={styles.reportRow}>
        <View style={styles.reportStat}>
          <Text style={[styles.reportStatValue, { color: PALETTE.emeraldAccent }]}>
            {totalSynced}
          </Text>
          <Text style={styles.reportStatLabel}>synced</Text>
        </View>

        <View style={styles.reportDivider} />

        <View style={styles.reportStat}>
          <Text style={[styles.reportStatValue, { color: PALETTE.amberAccent }]}>
            {report.retried}
          </Text>
          <Text style={styles.reportStatLabel}>retried</Text>
        </View>

        <View style={styles.reportDivider} />

        <View style={styles.reportStat}>
          <Text style={[styles.reportStatValue, { color: PALETTE.red }]}>
            {report.permanently_failed}
          </Text>
          <Text style={styles.reportStatLabel}>failed</Text>
        </View>

        <View style={styles.reportDivider} />

        <View style={styles.reportStat}>
          <Text style={[styles.reportStatValue, { color: PALETTE.slateAccent }]}>
            {elapsed}
          </Text>
          <Text style={styles.reportStatLabel}>elapsed</Text>
        </View>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Props interface
// ─────────────────────────────────────────────────────────────────────────────

export interface DriverSyncDashboardProps {
  /**
   * Instantiated SyncManager. Its processOfflineQueue() is invoked on every
   * manual force-sync trigger. Must be the same instance managing background
   * connectivity monitoring so queue mutations are visible in both paths.
   */
  syncManager: SyncManager;

  /**
   * The ConnectivityProbe injected into the SyncManager — polled independently
   * by this component to drive the real-time NetworkStatusBanner UI without
   * requiring an internal state-change event from the SyncManager.
   */
  connectivityProbe: ConnectivityProbe;

  /**
   * Async function returning pending queue entries for the diagnostic list.
   * Defaults to LocalDatabase.getPendingQueueEntries. Override in tests or
   * Storybook with a mock that returns MOCK_PREVIEW_ENTRIES.
   */
  getPendingEntries?: () => Promise<QueueEntry[]>;

  /** Screen title displayed in the header bar. Defaults to "Sync Status". */
  title?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DriverSyncDashboard — main component
// ─────────────────────────────────────────────────────────────────────────────

export default function DriverSyncDashboard({
  syncManager,
  connectivityProbe,
  getPendingEntries = getPendingQueueEntries,
  title             = 'Sync Status',
}: DriverSyncDashboardProps) {
  // Live connectivity state — polled from the injected probe.
  const connectivityState = useConnectivity(connectivityProbe);

  // Incrementing this counter causes usePendingQueue to re-fetch immediately
  // after a completed manual sync, so the list reflects new state without
  // waiting for the next POLL_INTERVAL_MS tick.
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Pending queue entries — polled at POLL_INTERVAL_MS + after every sync.
  const { entries, entryCount, isLoading: isLoadingQueue, fetchError } =
    usePendingQueue(getPendingEntries, refreshTrigger);

  // Active sync and result state.
  const [isSyncing, setIsSyncing]   = useState(false);
  const [lastReport, setLastReport] = useState<QueueProcessingReport | null>(null);
  const [syncError, setSyncError]   = useState<string | null>(null);

  // Derived counts for the metric card pills.
  const { freshCount, retryingCount } = useMemo(() => ({
    freshCount:    entries.filter(e => e.attempt_count < BACKOFF_THRESHOLD).length,
    retryingCount: entries.filter(e => e.attempt_count >= BACKOFF_THRESHOLD).length,
  }), [entries]);

  // Spring-scale animation that gives the Force Sync button haptic-like
  // immediacy before the async processOfflineQueue() result arrives.
  const buttonScale = useRef(new Animated.Value(1)).current;

  const animatePress = useCallback(() => {
    Animated.sequence([
      Animated.spring(buttonScale, {
        toValue:         0.95,
        speed:           80,
        bounciness:      0,
        useNativeDriver: true,
      }),
      Animated.spring(buttonScale, {
        toValue:         1,
        speed:           20,
        bounciness:      12,
        useNativeDriver: true,
      }),
    ]).start();
  }, [buttonScale]);

  const handleForceSync = useCallback(async () => {
    if (isSyncing) return;
    animatePress();
    setIsSyncing(true);
    setSyncError(null);
    try {
      const report = await syncManager.processOfflineQueue();
      setLastReport(report);
      setRefreshTrigger(t => t + 1);
    } catch (err) {
      setSyncError(
        err instanceof Error
          ? err.message
          : 'Sync encountered an unexpected error.',
      );
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing, syncManager, animatePress]);

  // Stable FlatList callbacks — recreating these on every render would reset
  // the virtualised list's internal scroll/measure state unnecessarily.
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<QueueEntry>) => <QueueEntryRow entry={item} />,
    [],
  );

  const keyExtractor = useCallback(
    (item: QueueEntry) => item.idempotency_key,
    [],
  );

  const ItemSeparator = useCallback(
    () => <View style={styles.separator} />,
    [],
  );

  // Rendered when the queue is empty and not in the initial loading state.
  const EmptyQueue = useMemo(
    () => (
      <View style={styles.emptyState}>
        <View style={styles.emptyDot} />
        <Text style={styles.emptyTitle}>Queue is clear</Text>
        <Text style={styles.emptySubtitle}>
          All local transactions have been transmitted to the KONA backend.
        </Text>
      </View>
    ),
    [],
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerBrand}>
          <View style={styles.brandDot} />
          <Text style={styles.brandName}>KONA</Text>
        </View>
        <Text style={styles.headerTitle}>{title}</Text>
      </View>

      {/* ── Scrollable body via FlatList (virtualised) ─────────────────────── */}
      <FlatList<QueueEntry>
        data={entries}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ItemSeparatorComponent={ItemSeparator}
        ListEmptyComponent={isLoadingQueue ? null : EmptyQueue}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <>
            {/* Connectivity banner */}
            <NetworkStatusBanner state={connectivityState} />

            {/* Pending queue metric */}
            <QueueMetricCard
              count={entryCount}
              isSyncing={isSyncing}
              freshCount={freshCount}
              retryingCount={retryingCount}
            />

            {/* Diagnostic list heading */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>QUEUE DIAGNOSTICS</Text>
              {isLoadingQueue && (
                <ActivityIndicator size="small" color={PALETTE.textTertiary} />
              )}
            </View>
          </>
        }
        ListFooterComponent={
          <>
            {/* Last sync summary */}
            {lastReport !== null && <LastSyncReport report={lastReport} />}

            {/* Sync error */}
            {syncError !== null && (
              <View style={styles.errorCard}>
                <Text style={styles.errorLabel}>SYNC ERROR</Text>
                <Text style={styles.errorMessage}>{syncError}</Text>
              </View>
            )}

            {/* Queue fetch error */}
            {fetchError !== null && (
              <View style={styles.errorCard}>
                <Text style={styles.errorLabel}>QUEUE READ ERROR</Text>
                <Text style={styles.errorMessage}>{fetchError}</Text>
              </View>
            )}

            {/* Force sync CTA with spring animation wrapper */}
            <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
              <TouchableOpacity
                style={[
                  styles.forceSyncButton,
                  isSyncing && styles.forceSyncButtonActive,
                ]}
                onPress={() => void handleForceSync()}
                disabled={isSyncing}
                activeOpacity={0.8}
              >
                {isSyncing ? (
                  <View style={styles.forceSyncInner}>
                    <ActivityIndicator size="small" color={PALETTE.textPrimary} />
                    <Text style={styles.forceSyncLabel}>TRANSMITTING…</Text>
                  </View>
                ) : (
                  <Text style={styles.forceSyncLabel}>FORCE SYNC NOW</Text>
                )}
              </TouchableOpacity>
            </Animated.View>

            <View style={styles.footerSpacer} />
          </>
        }
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// StyleSheet
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Root layout ────────────────────────────────────────────────────────────
  container: {
    flex:            1,
    backgroundColor: PALETTE.bg,
  },
  scrollContent: {
    paddingHorizontal: SPACING.lg,
    paddingBottom:     SPACING.xl,
  },

  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    flexDirection:    'row',
    alignItems:       'center',
    justifyContent:   'space-between',
    paddingHorizontal: SPACING.lg,
    paddingTop:        SPACING.xl,
    paddingBottom:     SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: PALETTE.border,
  },
  headerBrand: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           SPACING.sm,
  },
  brandDot: {
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: PALETTE.emerald,
  },
  brandName: {
    fontSize:      13,
    fontWeight:    '700',
    letterSpacing: 2.5,
    color:         PALETTE.textSecondary,
  },
  headerTitle: {
    fontSize:      15,
    fontWeight:    '600',
    letterSpacing: 0.4,
    color:         PALETTE.textPrimary,
  },

  // ── Network status banner ──────────────────────────────────────────────────
  banner: {
    marginTop:    SPACING.lg,
    borderRadius: RADIUS.lg,
    borderWidth:  1,
    padding:      SPACING.lg,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           SPACING.md,
  },
  bannerDot: {
    width:        10,
    height:       10,
    borderRadius: 5,
  },
  bannerTextGroup: {
    flex: 1,
  },
  bannerTitle: {
    fontSize:      11,
    fontWeight:    '700',
    letterSpacing: 1.8,
    marginBottom:  2,
  },
  bannerSubtitle: {
    fontSize:   12,
    color:      PALETTE.textSecondary,
    lineHeight: 16,
  },
  smsBadge: {
    marginTop:         SPACING.sm,
    alignSelf:         'flex-start',
    paddingHorizontal: SPACING.sm,
    paddingVertical:   3,
    borderRadius:      RADIUS.sm,
  },
  smsBadgeText: {
    fontSize:      9,
    fontWeight:    '800',
    letterSpacing: 1.5,
  },

  // ── Queue metric card ──────────────────────────────────────────────────────
  metricCard: {
    marginTop:       SPACING.lg,
    backgroundColor: PALETTE.surface,
    borderRadius:    RADIUS.xl,
    borderWidth:     1,
    borderColor:     PALETTE.border,
    padding:         SPACING.xl,
    alignItems:      'center',
  },
  metricLabel: {
    fontSize:      11,
    fontWeight:    '700',
    letterSpacing: 2,
    color:         PALETTE.textTertiary,
    marginBottom:  SPACING.sm,
  },
  metricCountRow: {
    height:         80,
    justifyContent: 'center',
    alignItems:     'center',
  },
  metricCount: {
    fontSize:           68,
    fontWeight:         '800',
    color:              PALETTE.textPrimary,
    lineHeight:         80,
    includeFontPadding: false,
  },
  metricSpinner: {
    transform: [{ scale: 1.6 }],
  },
  metricCaption: {
    fontSize:   13,
    color:      PALETTE.textSecondary,
    marginTop:  SPACING.sm,
    textAlign:  'center',
    lineHeight: 18,
  },
  metricPillRow: {
    flexDirection: 'row',
    gap:           SPACING.sm,
    marginTop:     SPACING.md,
  },
  metricPill: {
    paddingHorizontal: SPACING.sm,
    paddingVertical:   4,
    borderRadius:      RADIUS.sm,
  },
  metricPillText: {
    fontSize:      10,
    fontWeight:    '700',
    letterSpacing: 1,
  },

  // ── Section header ─────────────────────────────────────────────────────────
  sectionHeader: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginTop:      SPACING.xl,
    marginBottom:   SPACING.sm,
  },
  sectionLabel: {
    fontSize:      11,
    fontWeight:    '700',
    letterSpacing: 2,
    color:         PALETTE.textTertiary,
  },

  // ── Queue entry rows ───────────────────────────────────────────────────────
  entryRow: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: PALETTE.surface,
    borderRadius:    RADIUS.md,
    padding:         SPACING.md,
    gap:             SPACING.md,
  },
  actionBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical:   6,
    borderRadius:      RADIUS.sm,
    minWidth:          64,
    alignItems:        'center',
  },
  actionBadgeText: {
    fontSize:      10,
    fontWeight:    '800',
    letterSpacing: 1,
  },
  entryMeta: {
    flex: 1,
    gap:  2,
  },
  entryOrderId: {
    fontSize:   12,
    color:      PALETTE.textSecondary,
    fontFamily: 'monospace',
  },
  entryAttemptLabel: {
    fontSize:   11,
    color:      PALETTE.textTertiary,
    fontWeight: '500',
  },
  entryAttemptBackoff: {
    color: PALETTE.amber,
  },
  statusDot: {
    width:        8,
    height:       8,
    borderRadius: 4,
  },
  separator: {
    height: SPACING.xs,
  },

  // ── Empty state ────────────────────────────────────────────────────────────
  emptyState: {
    alignItems:    'center',
    paddingVertical: SPACING.xxl,
    gap:           SPACING.sm,
  },
  emptyDot: {
    width:           20,
    height:          20,
    borderRadius:    10,
    backgroundColor: PALETTE.emeraldDim,
    borderWidth:     2,
    borderColor:     PALETTE.emerald,
  },
  emptyTitle: {
    fontSize:   16,
    fontWeight: '600',
    color:      PALETTE.textPrimary,
    marginTop:  SPACING.xs,
  },
  emptySubtitle: {
    fontSize:  13,
    color:     PALETTE.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth:  260,
  },

  // ── Last sync report ───────────────────────────────────────────────────────
  reportCard: {
    marginTop:       SPACING.xl,
    backgroundColor: PALETTE.surfaceAlt,
    borderRadius:    RADIUS.lg,
    borderWidth:     1,
    borderColor:     PALETTE.border,
    padding:         SPACING.lg,
  },
  reportHeader: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   SPACING.md,
  },
  reportPathBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical:   3,
    borderRadius:      RADIUS.sm,
  },
  reportPathText: {
    fontSize:      10,
    fontWeight:    '700',
    letterSpacing: 1,
  },
  reportRow: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
  },
  reportStat: {
    flex:       1,
    alignItems: 'center',
    gap:        2,
  },
  reportStatValue: {
    fontSize:   22,
    fontWeight: '700',
  },
  reportStatLabel: {
    fontSize:      10,
    color:         PALETTE.textTertiary,
    fontWeight:    '600',
    letterSpacing: 0.6,
  },
  reportDivider: {
    width:           1,
    height:          36,
    backgroundColor: PALETTE.border,
  },

  // ── Error card ─────────────────────────────────────────────────────────────
  errorCard: {
    marginTop:       SPACING.md,
    backgroundColor: PALETTE.redDim,
    borderRadius:    RADIUS.md,
    borderWidth:     1,
    borderColor:     PALETTE.red,
    padding:         SPACING.md,
  },
  errorLabel: {
    fontSize:      10,
    fontWeight:    '700',
    letterSpacing: 1.5,
    color:         PALETTE.red,
    marginBottom:  SPACING.xs,
  },
  errorMessage: {
    fontSize:   12,
    color:      PALETTE.textSecondary,
    lineHeight: 18,
  },

  // ── Force sync button ──────────────────────────────────────────────────────
  forceSyncButton: {
    marginTop:       SPACING.xl,
    backgroundColor: PALETTE.surface,
    borderRadius:    RADIUS.lg,
    borderWidth:     1,
    borderColor:     PALETTE.blue,
    paddingVertical: SPACING.lg,
    alignItems:      'center',
    justifyContent:  'center',
  },
  forceSyncButtonActive: {
    borderColor:     PALETTE.slate,
    backgroundColor: PALETTE.surfaceAlt,
  },
  forceSyncInner: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           SPACING.sm,
  },
  forceSyncLabel: {
    fontSize:      13,
    fontWeight:    '700',
    letterSpacing: 2.5,
    color:         PALETTE.textPrimary,
  },

  // ── Footer ─────────────────────────────────────────────────────────────────
  footerSpacer: {
    height: SPACING.xxl,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock preview data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Realistic pending-queue entries covering all six OfflineActionType values
 * and three distinct attempt-count states:
 *
 *   0  — fresh, never dispatched       → green status dot, "pending first dispatch"
 *   1  — first retry / backoff active  → pulsing amber dot, "attempt 1 — backoff scheduled"
 *   4  — near MAX_RETRY_ATTEMPTS (5)   → pulsing amber dot, "attempt 4 — backoff scheduled"
 *
 * payload_compressed values are representative Base64 strings (not actual
 * lz-string output) suitable for rendering verification without a live DB.
 *
 * Usage — wire into the component for instant visual preview:
 *
 *   <DriverSyncDashboard
 *     syncManager={mockSyncManager}
 *     connectivityProbe={{ getState: () => 'sms_only' }}
 *     getPendingEntries={async () => MOCK_PREVIEW_ENTRIES}
 *   />
 */
const _PREVIEW_TS = Date.now();

export const MOCK_PREVIEW_ENTRIES: QueueEntry[] = [
  {
    id:                 1,
    idempotency_key:    'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    order_id:           'aaaaaaaa-0000-4000-8000-000000000001',
    action_type:        'booking_lock',
    payload_compressed: 'N4IgxgFgJiBcIBMBmAzANjAHgVQHYC2AtpADQgoAmCARgKYCUA+gCYCGA==',
    created_at:         _PREVIEW_TS - 480_000,
    attempt_count:      0,
    last_attempt_at:    null,
    synced_at:          null,
    sync_status:        'pending',
  },
  {
    id:                 2,
    idempotency_key:    'b2c3d4e5f6b2c3d4e5f6b2c3d4e5f6b2c3d4e5f6b2c3d4e5f6b2c3d4e5f6b2c3',
    order_id:           'bbbbbbbb-0000-4000-8000-000000000002',
    action_type:        'trip_settlement',
    payload_compressed: 'N4IgxgFgJiBcIBMCWBjANgVQHYGcC2AtpADQgoAmCARgKYCUAugVQHYA==',
    created_at:         _PREVIEW_TS - 360_000,
    attempt_count:      1,
    last_attempt_at:    _PREVIEW_TS - 120_000,
    synced_at:          null,
    sync_status:        'pending',
  },
  {
    id:                 3,
    idempotency_key:    'c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6',
    order_id:           'cccccccc-0000-4000-8000-000000000003',
    action_type:        'order_status_update',
    payload_compressed: 'N4Igxg9gJiBcIBMCWBjAN2gDgVQHYDOAtpADQgoAmCARgKYCUA==',
    created_at:         _PREVIEW_TS - 270_000,
    attempt_count:      2,
    last_attempt_at:    _PREVIEW_TS - 90_000,
    synced_at:          null,
    sync_status:        'pending',
  },
  {
    id:                 4,
    idempotency_key:    'd4e5f6d4e5f6d4e5f6d4e5f6d4e5f6d4e5f6d4e5f6d4e5f6d4e5f6d4e5f6d4e5',
    order_id:           'dddddddd-0000-4000-8000-000000000004',
    action_type:        'booking_reversal',
    payload_compressed: 'N4IgxgFgJiBcIBMCWBjARgKYFUB2BnAtpADQgoAmCARgKYCUA==',
    created_at:         _PREVIEW_TS - 180_000,
    attempt_count:      0,
    last_attempt_at:    null,
    synced_at:          null,
    sync_status:        'pending',
  },
  {
    id:                 5,
    idempotency_key:    'e5f6e5f6e5f6e5f6e5f6e5f6e5f6e5f6e5f6e5f6e5f6e5f6e5f6e5f6e5f6e5f6',
    order_id:           'eeeeeeee-0000-4000-8000-000000000005',
    action_type:        'driver_location_update',
    payload_compressed: 'N4IgxgFgJiBcIBMBmAjANjAHgVQHYC2AtpADQgoAmCARgKYCUA==',
    created_at:         _PREVIEW_TS - 90_000,
    attempt_count:      4,
    last_attempt_at:    _PREVIEW_TS - 18_000,
    synced_at:          null,
    sync_status:        'pending',
  },
  {
    id:                 6,
    idempotency_key:    'f6a1f6a1f6a1f6a1f6a1f6a1f6a1f6a1f6a1f6a1f6a1f6a1f6a1f6a1f6a1f6a1',
    order_id:           'ffffffff-0000-4000-8000-000000000006',
    action_type:        'dispatch_offer_response',
    payload_compressed: 'N4IgxgFgJiBcIBMDWBjAtpALgQwHYDOAtpADQgoAmCARgKYCUA==',
    created_at:         _PREVIEW_TS - 45_000,
    attempt_count:      0,
    last_attempt_at:    null,
    synced_at:          null,
    sync_status:        'pending',
  },
];
