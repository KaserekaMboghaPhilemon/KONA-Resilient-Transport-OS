import { TripRepository } from '../repositories/TripRepository';

/**
 * Sprint 8.5 – AppInitializer: Crash Recovery & Lifecycle Restoration
 *
 * Handles device boot-up initialization logic:
 * 1. Checks for any ACTIVE (uncompleted) trips in the local database.
 * 2. If active trips exist (e.g., device was powered off mid-trip), automatically
 *    restarts background location tracking for each active trip.
 * 3. Logs recovery state for operational visibility.
 *
 * Integration Points:
 *  - Called during app startup (e.g., in App.tsx useEffect, or native launch handler).
 *  - Queries TripRepository.getActiveTripIds() to discover uncompleted trips.
 *  - Invokes BackgroundLocationWorker.startTracking(tripId) for each active trip.
 *
 * Design Rationale:
 *  If the device crashes, reboots, or loses power during an active ride, KONA
 *  will detect the orphaned trip record and restore the background tracking stream
 *  without requiring driver intervention, preserving telemetry continuity.
 */

/**
 * Initializes the app and handles crash recovery for any active uncompleted trips.
 * Safe to call multiple times (idempotent).
 */
export async function initializeAppWithCrashRecovery(): Promise<void> {
  console.log('[AppInitializer] Starting app initialization with crash recovery check...');

  try {
    // Query for any trips left in ACTIVE state (device crash scenario)
    const activeTripIds = await TripRepository.getActiveTripIds();

    if (activeTripIds.length === 0) {
      console.log('[AppInitializer] ✓ No active trips found. App is in clean state.');
      return;
    }

    console.warn(
      `[AppInitializer] ⚠️ Detected ${activeTripIds.length} active trip(s). ` +
        `Initializing crash recovery...`,
    );

    // Dynamically import BackgroundLocationWorker to avoid loading expo dependencies at module init
    const { BackgroundLocationWorker } = await import('./BackgroundLocationWorker');

    // Restart background location tracking for each orphaned active trip
    for (const tripId of activeTripIds) {
      try {
        console.log(
          `[AppInitializer] 🚗 Restoring background location tracking for trip: ${tripId}`,
        );
        await BackgroundLocationWorker.startTracking(tripId);
      } catch (error) {
        console.error(
          `[AppInitializer] Failed to restore tracking for trip ${tripId}:`,
          error,
        );
        // Continue to the next trip; do not abort the entire recovery process.
      }
    }

    console.log(
      `[AppInitializer] ✓ Crash recovery completed. Tracking restored for ${activeTripIds.length} trip(s).`,
    );
  } catch (error) {
    console.error('[AppInitializer] Fatal error during initialization:', error);
    // Re-throw to ensure the error is visible; the app should handle gracefully.
    throw error;
  }
}

/**
 * Optional: Async function for async/await in app root.
 * Alternative to calling initializeAppWithCrashRecovery() in useEffect.
 */
export async function asyncInitializeApp(): Promise<void> {
  return initializeAppWithCrashRecovery();
}
