/**
 * Initializes the mobile runtime from durable local state before starting
 * background synchronization and location services.
 */
export async function initializeAppWithCrashRecovery(
  initialTripId?: string | null,
): Promise<void> {
  console.log('[AppInitializer] Initializing local runtime and recovering pending work.');

  try {
    const { getPendingQueueEntries, initDatabase } = await import('../db/LocalDatabase');
    const { StateCoordinator } = await import('./StateCoordinator');
    const { BackgroundLocationWorker } = await import('./BackgroundLocationWorker');

    await initDatabase();
    const pendingEntries = await getPendingQueueEntries();
    const requestedTripId = initialTripId?.trim() ?? '';
    let activeTripId: string | null = null;

    try {
      if (requestedTripId) {
        await BackgroundLocationWorker.startTracking(requestedTripId);
        activeTripId = requestedTripId;
      } else {
        activeTripId = await BackgroundLocationWorker.restoreActiveTrip();
      }
    } catch (error) {
      console.error('[AppInitializer] Location tracking recovery failed:', error);
      activeTripId = await BackgroundLocationWorker.resolveActiveTripId();
    }

    await StateCoordinator.prepareRuntimeServices();

    const syncScope = activeTripId ?? pendingEntries[0]?.order_id ?? null;
    if (syncScope) {
      await StateCoordinator.syncAllSystems(syncScope);
    }

    await StateCoordinator.startRuntimeServices(activeTripId);
    console.log(
      `[AppInitializer] Runtime ready; ${pendingEntries.length} pending local action(s) found.`,
    );
  } catch (error) {
    console.error('[AppInitializer] Fatal error during initialization:', error);
    throw error;
  }
}

export async function asyncInitializeApp(
  initialTripId?: string | null,
): Promise<void> {
  return initializeAppWithCrashRecovery(initialTripId);
}
