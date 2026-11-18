import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { knex } from '../../src/database/knex';
import { IdempotencyRepository } from '../../src/repositories/IdempotencyRepository';

const describeWhenEnabled =
  process.env.KONA_RUN_INTEGRATION_TESTS === '1' ? describe : describe.skip;

describeWhenEnabled('PostgreSQL/pgvector and Redis integration', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let redis: Redis;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error('DATABASE_URL and REDIS_URL are required for integration tests.');
    }
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
  });

  afterAll(async () => {
    await Promise.all([pool.end(), redis?.quit(), knex.destroy()]);
  });

  it('creates an HNSW vector index and returns the nearest embedding', async () => {
    const client = await pool.connect();
    try {
      const extension = await client.query<{ extversion: string }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      );
      expect(extension.rows[0]?.extversion).toBeTruthy();

      await client.query(`
        CREATE TEMP TABLE kona_integration_embeddings (
          id integer PRIMARY KEY,
          embedding vector(3) NOT NULL
        )
      `);
      await client.query(
        'INSERT INTO kona_integration_embeddings (id, embedding) VALUES (1, $1::vector), (2, $2::vector)',
        ['[1,2,3]', '[3,2,1]'],
      );
      await client.query(`
        CREATE INDEX kona_integration_embeddings_hnsw
        ON kona_integration_embeddings USING hnsw (embedding vector_l2_ops)
      `);

      const nearest = await client.query<{ id: number; distance: number }>(
        `SELECT id, embedding <-> $1::vector AS distance
         FROM kona_integration_embeddings
         ORDER BY embedding <-> $1::vector
         LIMIT 1`,
        ['[1,2,3]'],
      );
      expect(nearest.rows[0]).toMatchObject({ id: 1, distance: 0 });
    } finally {
      client.release();
    }
  });

  it('round-trips and removes a unique Redis payload', async () => {
    const key = `kona:integration:${randomUUID()}`;
    const value = JSON.stringify({ timestamp: Date.now(), nonce: randomUUID() });
    try {
      expect(await redis.set(key, value, 'EX', 30)).toBe('OK');
      expect(await redis.get(key)).toBe(value);
    } finally {
      await redis.del(key);
    }
    expect(await redis.get(key)).toBeNull();
  });

  it('round-trips a job through the Redis-backed BullMQ broker', async () => {
    const redisUrl = new URL(process.env.REDIS_URL as string);
    const connection = {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      ...(redisUrl.username ? { username: decodeURIComponent(redisUrl.username) } : {}),
      ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}),
      maxRetriesPerRequest: null,
    };
    const queueName = `kona-integration-${randomUUID()}`;
    const queue = new Queue(queueName, { connection });
    const worker = new Worker(
      queueName,
      async (job) => ({ echoed: job.data.payload }),
      { connection },
    );
    const events = new QueueEvents(queueName, { connection });

    try {
      await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
      const payload = randomUUID();
      const job = await queue.add('echo', { payload }, { removeOnComplete: true });
      await expect(job.waitUntilFinished(events, 10_000)).resolves.toEqual({ echoed: payload });
    } finally {
      await Promise.all([worker.close(), events.close()]);
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('detects a duplicate idempotency key in PostgreSQL', async () => {
    const key = `integration-duplicate:${randomUUID()}`;

    await knex.transaction(async (trx) => {
      await expect(IdempotencyRepository.checkAndRegisterKey(key, trx)).resolves.toBe(false);
    });
    await knex.transaction(async (trx) => {
      await expect(IdempotencyRepository.checkAndRegisterKey(key, trx)).resolves.toBe(true);
    });
    await knex('processed_idempotency_keys').where({ key }).del();
  });

  it('rolls back both idempotency registration and domain writes on a constraint violation', async () => {
    const key = `integration:${randomUUID()}`;
    const orderId = randomUUID();
    const driverId = randomUUID();
    await knex('drivers').insert({
      driver_id: driverId,
      full_name: 'KONA Integration Test',
      phone_e164: `+1555${Date.now()}${Math.floor(Math.random() * 1000)}`,
      home_h3_cell: 'integration',
    });

    try {
      await expect(
        knex.transaction(async (trx) => {
          expect(await IdempotencyRepository.checkAndRegisterKey(key, trx)).toBe(false);
          await trx('trips').insert({
            order_id: orderId,
            driver_id: driverId,
            status: 'ACTIVE',
          });
          await trx('trips').insert({
            order_id: orderId,
            driver_id: driverId,
            status: 'CONSTRAINT_VIOLATION',
          });
        }),
      ).rejects.toThrow();

      const [idempotencyRow, tripRow] = await Promise.all([
        knex('processed_idempotency_keys').where({ key }).first(),
        knex('trips').where({ order_id: orderId }).first(),
      ]);
      expect(idempotencyRow).toBeUndefined();
      expect(tripRow).toBeUndefined();
    } finally {
      await knex('drivers').where({ driver_id: driverId }).del();
    }
  });
});
