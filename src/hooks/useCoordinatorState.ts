import { useEffect, useState } from 'react';

import {
  StateCoordinator,
  type CoordinatorSnapshot,
} from '../services/StateCoordinator';

export function useCoordinatorState(): CoordinatorSnapshot {
  const [snapshot, setSnapshot] = useState<CoordinatorSnapshot>(() =>
    StateCoordinator.getSnapshot(),
  );

  useEffect(() => {
    const unsubscribe = StateCoordinator.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return snapshot;
}
