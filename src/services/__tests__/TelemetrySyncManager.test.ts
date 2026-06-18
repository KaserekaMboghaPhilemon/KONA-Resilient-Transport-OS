/**
 * Sprint 9 – Task 9.4: TelemetrySyncManager Periodic Daemon & Exponential Backoff Tests
 *
 * Verifies:
 *  1. startPeriodicSync / stopPeriodicSync basic lifecycle.
 *  2. Successful cycles fire at the baseline interval.
 *  3. Failed cycles apply exponential backoff capped at TELEMETRY_MAX_DELAY_MS.
 *  4. computeBackoffDelay math matches the specification.
 *  5. Stopping the daemon mid-cycle prevents further ticks.
 */

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports so Jest hoists them correctly.
// Expo modules (expo-sqlite, expo-sms) must be mocked to avoid Jest parse errors.
// ---------------------------------------------------------------------------
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

jest.mock('expo-sms', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  sendSMSAsync: jest.fn(),
}));

jest.mock('base45', () => ({
  encode: jest.fn((_buf: Buffer) => 'MOCK_B45_PAYLOAD'),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import {
  TelemetrySyncManager,
  TELEMETRY_BASE_INTERVAL_MS,
  TELEMETRY_MAX_DELAY_MS,
} from '../TelemetrySyncManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Cast target used by jest.spyOn to avoid strict never-key inference.
type TelemetrySyncManagerClass = typeof TelemetrySyncManager & {
  processTelemetrySync(tripId: string): Promise<void>;
};

/**
 * Spy-stubs processTelemetrySync on the class so daemon tests never touch
 * SQLite / network.  The stub resolves successfully by default.
 */
function stubProcessSync(
  implementation: () => Promise<void> = () => Promise.resolve(),
): jest.SpyInstance {
  return jest
    .spyOn(TelemetrySyncManager as unknown as TelemetrySyncManagerClass, 'processTelemetrySync')
    .mockImplementation(implementation);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('TelemetrySyncManager – Task 9.4 Periodic Daemon & Backoff', () => {
  beforeEach(() => {
    // Reset static state between tests so daemon leaks don't bleed across.
    TelemetrySyncManager.stopPeriodicSync();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    TelemetrySyncManager.stopPeriodicSync();
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // computeBackoffDelay math
  // -------------------------------------------------------------------------
  describe('computeBackoffDelay()', () => {
    it('returns base interval when consecutiveFailures = 0', () => {
      expect(TelemetrySyncManager.computeBackoffDelay(0)).toBe(TELEMETRY_BASE_INTERVAL_MS);
    });

    it('doubles the base interval after 1 failure', () => {
      expect(TelemetrySyncManager.computeBackoffDelay(1)).toBe(TELEMETRY_BASE_INTERVAL_MS * 2);
    });

    it('quadruples the base interval after 2 failures', () => {
      expect(TelemetrySyncManager.computeBackoffDelay(2)).toBe(TELEMETRY_BASE_INTERVAL_MS * 4);
    });

    it('returns exactly max delay for a very large failure count', () => {
      expect(TelemetrySyncManager.computeBackoffDelay(100)).toBe(TELEMETRY_MAX_DELAY_MS);
    });

    it('never exceeds TELEMETRY_MAX_DELAY_MS regardless of failure count', () => {
      for (let n = 0; n <= 25; n++) {
        expect(TelemetrySyncManager.computeBackoffDelay(n)).toBeLessThanOrEqual(
          TELEMETRY_MAX_DELAY_MS,
        );
      }
    });

    it('matches the specification formula: min(base × 2^n, max)', () => {
      for (let n = 0; n <= 10; n++) {
        const expected = Math.min(
          TELEMETRY_BASE_INTERVAL_MS * Math.pow(2, n),
          TELEMETRY_MAX_DELAY_MS,
        );
        expect(TelemetrySyncManager.computeBackoffDelay(n)).toBe(expected);
      }
    });
  });

  // -------------------------------------------------------------------------
  // startPeriodicSync – basic lifecycle
  // -------------------------------------------------------------------------
  describe('startPeriodicSync()', () => {
    it('throws TypeError for an empty tripId', () => {
      expect(() => TelemetrySyncManager.startPeriodicSync('')).toThrow(TypeError);
    });

    it('throws TypeError for a whitespace-only tripId', () => {
      expect(() => TelemetrySyncManager.startPeriodicSync('   ')).toThrow(TypeError);
    });

    it('does not throw for a valid tripId', () => {
      jest.useFakeTimers();
      stubProcessSync();
      expect(() => TelemetrySyncManager.startPeriodicSync('trip-001')).not.toThrow();
    });

    it('replacing an active daemon clears the prior timer', () => {
      jest.useFakeTimers();
      const spy = stubProcessSync();

      TelemetrySyncManager.startPeriodicSync('trip-001');
      TelemetrySyncManager.startPeriodicSync('trip-002'); // replaces 'trip-001'

      // Advance past one baseline interval — only trip-002 should ever run.
      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS + 1);

      // processTelemetrySync should have been called exactly once (for trip-002).
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('trip-002');
    });
  });

  // -------------------------------------------------------------------------
  // stopPeriodicSync()
  // -------------------------------------------------------------------------
  describe('stopPeriodicSync()', () => {
    it('does not throw when called with no active daemon', () => {
      expect(() => TelemetrySyncManager.stopPeriodicSync()).not.toThrow();
    });

    it('prevents further cycle execution after stop', () => {
      jest.useFakeTimers();
      const spy = stubProcessSync();

      TelemetrySyncManager.startPeriodicSync('trip-001');
      TelemetrySyncManager.stopPeriodicSync();

      // Even advancing far past the interval should not fire any cycle.
      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS * 10);

      expect(spy).not.toHaveBeenCalled();
    });

    it('is idempotent — calling twice is safe', () => {
      jest.useFakeTimers();
      TelemetrySyncManager.stopPeriodicSync();
      expect(() => TelemetrySyncManager.stopPeriodicSync()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Successful cycle timing
  // -------------------------------------------------------------------------
  describe('Successful cycle pacing', () => {
    it('fires one cycle after exactly one baseline interval', async () => {
      jest.useFakeTimers();
      const spy = stubProcessSync();

      TelemetrySyncManager.startPeriodicSync('trip-abc');
      expect(spy).not.toHaveBeenCalled(); // Not fired before the interval

      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS);
      await Promise.resolve(); // flush microtask queue (setTimeout callback)

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('fires two cycles after two baseline intervals', async () => {
      jest.useFakeTimers();
      const spy = stubProcessSync();

      TelemetrySyncManager.startPeriodicSync('trip-abc');

      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS);
      await Promise.resolve();

      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve(); // second reschedule

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('always passes the correct tripId to processTelemetrySync', async () => {
      jest.useFakeTimers();
      const spy = stubProcessSync();

      TelemetrySyncManager.startPeriodicSync('trip-xyz-456');

      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS);
      await Promise.resolve();

      expect(spy).toHaveBeenCalledWith('trip-xyz-456');
    });

    it('resets failure counter to 0 after a successful cycle', async () => {
      jest.useFakeTimers();

      // First cycle throws, second succeeds.
      const spy = stubProcessSync()
        .mockRejectedValueOnce(new Error('Network dropout'))
        .mockResolvedValue(undefined);

      TelemetrySyncManager.startPeriodicSync('trip-001');

      // Let the failure cycle execute.
      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();

      // Let the backoff interval expire and the successful cycle run.
      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS * 2); // failure #1 backoff = base × 2
      await Promise.resolve();
      await Promise.resolve();

      // Now one more baseline interval — cycle 3 should be at base speed.
      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();

      // Cycle 1 (fail) + cycle 2 (success) + cycle 3 (success at baseline) = 3 calls.
      expect(spy).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // Failure / backoff behaviour
  // -------------------------------------------------------------------------
  describe('Exponential backoff on failure', () => {
    it('does not fire a second cycle at baseline when the first cycle fails', async () => {
      jest.useFakeTimers();
      const spy = stubProcessSync().mockRejectedValue(new Error('SMS timeout'));

      TelemetrySyncManager.startPeriodicSync('trip-001');

      // Advance to just before what the backoff delay would be.
      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();

      // After failure #1, next interval = base × 2^1. Advance just short of it.
      const backoffAfterOneFail = TelemetrySyncManager.computeBackoffDelay(1);
      jest.advanceTimersByTime(backoffAfterOneFail - 1);
      await Promise.resolve();

      // Only the first failing cycle should have run by now.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('fires second cycle at the computed backoff delay after first failure', async () => {
      jest.useFakeTimers();
      const spy = stubProcessSync().mockRejectedValue(new Error('SMS timeout'));

      TelemetrySyncManager.startPeriodicSync('trip-001');

      // Cycle 1 fires.
      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();

      // Advance to the computed backoff for failure #1.
      const backoffAfterOneFail = TelemetrySyncManager.computeBackoffDelay(1);
      jest.advanceTimersByTime(backoffAfterOneFail);
      await Promise.resolve();
      await Promise.resolve();

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('applies increasingly longer delays for successive failures', async () => {
      jest.useFakeTimers();
      const spy = stubProcessSync().mockRejectedValue(new Error('No coverage'));

      TelemetrySyncManager.startPeriodicSync('trip-001');

      // Run 3 consecutive failing cycles.
      for (let cycleNum = 1; cycleNum <= 3; cycleNum++) {
        const prevDelay =
          cycleNum === 1
            ? TELEMETRY_BASE_INTERVAL_MS
            : TelemetrySyncManager.computeBackoffDelay(cycleNum - 1);

        jest.advanceTimersByTime(prevDelay);
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(spy).toHaveBeenCalledTimes(3);

      // Verify the delays are strictly increasing (up to max).
      const d1 = TelemetrySyncManager.computeBackoffDelay(1);
      const d2 = TelemetrySyncManager.computeBackoffDelay(2);
      const d3 = TelemetrySyncManager.computeBackoffDelay(3);

      expect(d2).toBeGreaterThanOrEqual(d1);
      expect(d3).toBeGreaterThanOrEqual(d2);
    });

    it('caps backoff at TELEMETRY_MAX_DELAY_MS even after many failures', () => {
      expect(TelemetrySyncManager.computeBackoffDelay(50)).toBe(TELEMETRY_MAX_DELAY_MS);
    });
  });

  // -------------------------------------------------------------------------
  // Daemon stop mid-session
  // -------------------------------------------------------------------------
  describe('Stopping daemon mid-session', () => {
    it('does not fire any more cycles after stop is called', async () => {
      jest.useFakeTimers();
      const spy = stubProcessSync();

      TelemetrySyncManager.startPeriodicSync('trip-001');

      // Fire first cycle.
      jest.advanceTimersByTime(TELEMETRY_BASE_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();

      expect(spy).toHaveBeenCalledTimes(1);

      // Stop the daemon.
      TelemetrySyncManager.stopPeriodicSync();

      // Advance far into the future — no new cycles should fire.
      jest.advanceTimersByTime(TELEMETRY_MAX_DELAY_MS * 2);
      await Promise.resolve();

      expect(spy).toHaveBeenCalledTimes(1); // still just 1
    });
  });
});
