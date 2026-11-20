import { Router, type Request, type Response } from 'express';
import Redis from 'ioredis';
import { knex } from '../database/knex';
import { syncMetrics, type SyncMetrics } from '../services/SyncMetrics';

export type DependencyCheck = () => Promise<void>;

export interface HealthDependencies {
  postgres: DependencyCheck;
  redis: DependencyCheck;
}

const HEALTH_CHECK_TIMEOUT_MS = 1_000;

const defaultDependencies: HealthDependencies = {
  async postgres(): Promise<void> {
    await knex.raw('SELECT 1').timeout(HEALTH_CHECK_TIMEOUT_MS, { cancel: true });
  },
  async redis(): Promise<void> {
    const redisUrl = process.env.REDIS_URL?.trim();
    if (!redisUrl) {
      throw new Error('Redis is not configured.');
    }

    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: HEALTH_CHECK_TIMEOUT_MS,
      commandTimeout: HEALTH_CHECK_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    redis.on('error', () => undefined);

    try {
      await redis.connect();
      const response = await redis.ping();
      if (response !== 'PONG') {
        throw new Error('Redis readiness probe failed.');
      }
    } finally {
      redis.disconnect();
    }
  },
};

function createHealthRouter(
  dependencies: HealthDependencies = defaultDependencies,
  metrics: SyncMetrics = syncMetrics,
): Router {
  const router = Router();

  router.get('/health/live', (_req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ status: 'alive' });
  });

  router.get('/health/ready', async (_req: Request, res: Response): Promise<void> => {
    const check = async (probe: DependencyCheck): Promise<'ok' | 'unavailable'> => {
      try {
        await probe();
        return 'ok';
      } catch {
        return 'unavailable';
      }
    };

    const [postgres, redis] = await Promise.all([
      check(dependencies.postgres),
      check(dependencies.redis),
    ]);
    const ready = postgres === 'ok' && redis === 'ok';

    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      dependencies: { postgres, redis },
    });
  });

  router.get('/metrics', (_req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(metrics.toPrometheus());
  });

  return router;
}

export { createHealthRouter };
export default createHealthRouter();
