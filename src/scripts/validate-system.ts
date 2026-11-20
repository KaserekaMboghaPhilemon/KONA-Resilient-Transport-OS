import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import Redis from 'ioredis';

type CheckDetails = Record<string, string | number | boolean>;
type Check = {
  subsystem: string;
  status: 'PASS' | 'FAIL';
  message: string;
  details?: CheckDetails;
};

const checks: Check[] = [];
const colors = {
  red: '\u001b[31m',
  green: '\u001b[32m',
  reset: '\u001b[0m',
};

function report(check: Check): void {
  checks.push(check);
  const color = check.status === 'PASS' ? colors.green : colors.red;
  const output = JSON.stringify(check);
  const line = process.env.NO_COLOR === undefined ? `${color}${output}${colors.reset}` : output;

  if (check.status === 'PASS') {
    console.log(line);
  } else {
    console.error(line);
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/((?:postgres(?:ql)?|redis):\/\/)[^@\s]+@/gi, '$1[redacted]@');
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

async function validatePostgres(): Promise<CheckDetails> {
  const pool = new Pool({
    connectionString: requireEnvironment('DATABASE_URL'),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    query_timeout: 5000,
    statement_timeout: 5000,
    max: 1,
  });
  let client: PoolClient | undefined;
  let transactionOpen = false;
  let failure: unknown;
  const cleanupFailures: string[] = [];
  let details: CheckDetails = {};

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;

    const timestamp = await client.query<{ current_time: Date }>(
      'SELECT CURRENT_TIMESTAMP AS current_time',
    );
    const currentTime = timestamp.rows[0]?.current_time;
    if (!(currentTime instanceof Date) || Number.isNaN(currentTime.getTime())) {
      throw new Error('PostgreSQL did not return a valid current timestamp.');
    }

    const extension = await client.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    const vectorVersion = extension.rows[0]?.extversion;
    if (!vectorVersion) {
      throw new Error('The pgvector extension is not active in this database.');
    }

    const accessMethods = await client.query<{ amname: string }>(
      "SELECT amname FROM pg_am WHERE amname IN ('hnsw', 'ivfflat')",
    );
    if (!accessMethods.rows.some((row) => row.amname === 'hnsw')) {
      throw new Error('pgvector HNSW index access method is unavailable.');
    }

    await client.query(`
      CREATE TEMP TABLE kona_system_validation_embeddings (
        id integer PRIMARY KEY,
        embedding vector(3) NOT NULL
      )
    `);
    await client.query(
      'INSERT INTO kona_system_validation_embeddings (id, embedding) VALUES (1, $1::vector), (2, $2::vector)',
      ['[1,2,3]', '[3,2,1]'],
    );
    await client.query(`
      CREATE INDEX kona_system_validation_embeddings_hnsw
      ON kona_system_validation_embeddings
      USING hnsw (embedding vector_l2_ops)
    `);

    const nearestEmbedding = await client.query<{ id: number; distance: number }>(
      `SELECT id, embedding <-> $1::vector AS distance
       FROM kona_system_validation_embeddings
       ORDER BY embedding <-> $1::vector
       LIMIT 1`,
      ['[1,2,3]'],
    );
    const nearest = nearestEmbedding.rows[0];
    if (!nearest || nearest.id !== 1 || Number(nearest.distance) !== 0) {
      throw new Error('pgvector distance query returned an unexpected nearest embedding.');
    }

    const migrationTables = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'trips',
           'telemetry_ingestion_batches',
           'processed_idempotency_keys',
           'ledger_transactions',
           'ledger_entries'
         )`,
    );
    const requiredTables = new Set([
      'trips',
      'telemetry_ingestion_batches',
      'processed_idempotency_keys',
      'ledger_transactions',
      'ledger_entries',
    ]);
    const missingTables = [...requiredTables].filter(
      (tableName) => !migrationTables.rows.some((row) => row.table_name === tableName),
    );
    if (missingTables.length > 0) {
      throw new Error(`Required database tables are missing: ${missingTables.join(', ')}.`);
    }

    const ledgerBalance = await client.query<{ unbalanced_transactions: string }>(
      `SELECT COUNT(*)::text AS unbalanced_transactions
       FROM (
         SELECT lt.ledger_transaction_id
         FROM ledger_transactions lt
         LEFT JOIN ledger_entries le
           ON le.ledger_transaction_id = lt.ledger_transaction_id
         WHERE lt.status = 'posted'
         GROUP BY lt.ledger_transaction_id
         HAVING COALESCE(SUM(
           CASE le.entry_side
             WHEN 'debit' THEN le.amount_minor
             WHEN 'credit' THEN -le.amount_minor
             ELSE 0
           END
         ), 0) <> 0
            OR COUNT(le.ledger_entry_id) < 2
       ) unbalanced`,
    );
    if (Number(ledgerBalance.rows[0]?.unbalanced_transactions ?? '1') !== 0) {
      throw new Error('One or more posted ledger transactions are unbalanced.');
    }

    details = {
      currentTime: currentTime.toISOString(),
      vectorVersion,
      hnswIndexCreated: true,
      nearestEmbeddingDistance: Number(nearest.distance),
      requiredTablesPresent: true,
      postedLedgerTransactionsBalanced: true,
    };
  } catch (error) {
    failure = error;
  } finally {
    if (client && transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (error) {
        cleanupFailures.push(`PostgreSQL rollback failed: ${errorMessage(error)}`);
      }
    }
    client?.release();
    try {
      await pool.end();
    } catch (error) {
      cleanupFailures.push(`PostgreSQL connection cleanup failed: ${errorMessage(error)}`);
    }
  }

  if (failure || cleanupFailures.length > 0) {
    const messages = [
      ...(failure ? [errorMessage(failure)] : []),
      ...cleanupFailures,
    ];
    throw new Error(messages.join('; '));
  }

  return details;
}

async function validateRedis(): Promise<CheckDetails> {
  const redis = new Redis(requireEnvironment('REDIS_URL'), {
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  const key = `kona:system-validation:${process.pid}:${randomUUID()}`;
  const payload = JSON.stringify({
    check: 'kona-system-validation',
    timestamp: new Date().toISOString(),
    nonce: randomUUID(),
  });
  let connected = false;
  let failure: unknown;
  const cleanupFailures: string[] = [];
  const redisEventErrors: string[] = [];
  let details: CheckDetails = {};
  redis.on('error', (error: Error) => {
    if (redisEventErrors.length < 3) {
      redisEventErrors.push(errorMessage(error));
    }
  });

  try {
    await redis.connect();
    connected = true;
    await redis.set(key, payload, 'EX', 60);
    const returnedPayload = await redis.get(key);
    if (returnedPayload !== payload) {
      throw new Error('Redis round-trip payload did not match the written value.');
    }

    const deletedCount = await redis.del(key);
    if (deletedCount !== 1) {
      throw new Error(`Redis cleanup deleted ${deletedCount} keys instead of one.`);
    }
    details = { roundTripVerified: true, temporaryKeyDeleted: true };
  } catch (error) {
    failure = error;
  } finally {
    if (connected) {
      try {
        await redis.del(key);
      } catch (error) {
        cleanupFailures.push(`Redis key cleanup failed: ${errorMessage(error)}`);
      }
      try {
        await redis.quit();
      } catch (error) {
        cleanupFailures.push(`Redis connection cleanup failed: ${errorMessage(error)}`);
        redis.disconnect();
      }
    } else {
      redis.disconnect();
    }
  }

  if (redisEventErrors.length > 0) {
    cleanupFailures.push(`Redis emitted connection error(s): ${redisEventErrors.join(' | ')}`);
  }

  if (failure || cleanupFailures.length > 0) {
    const messages = [
      ...(failure ? [errorMessage(failure)] : []),
      ...cleanupFailures,
    ];
    throw new Error(messages.join('; '));
  }

  return details;
}

async function validateBackend(): Promise<CheckDetails> {
  if (!existsSync('/.dockerenv') && process.env.KONA_ALLOW_HOST_VALIDATION !== 'true') {
    throw new Error(
      'System validation must run in a container or with KONA_ALLOW_HOST_VALIDATION=true.',
    );
  }

  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid backend PORT value: ${process.env.PORT ?? ''}.`);
  }

  const endpoint =
    process.env.KONA_API_HEALTH_URL?.trim() || `http://127.0.0.1:${port}/`;
  const response = await fetch(endpoint, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Backend root endpoint returned HTTP ${response.status}.`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(`Backend root endpoint returned unexpected content type: ${contentType || '(missing)'}.`);
  }

  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    (body as Record<string, unknown>).status !== 'success' ||
    (body as Record<string, unknown>).message !== 'KONA Transport OS API is running'
  ) {
    throw new Error('Backend root endpoint returned an unexpected JSON health response.');
  }

  return {
    containerMarkerPresent: existsSync('/.dockerenv'),
    hostValidationAllowed: process.env.KONA_ALLOW_HOST_VALIDATION === 'true',
    nodeEnvironment: process.env.NODE_ENV ?? 'unset',
    port,
    httpStatus: response.status,
    jsonResponseVerified: true,
  };
}

async function runCheck(
  subsystem: string,
  validate: () => Promise<CheckDetails>,
): Promise<void> {
  try {
    const details = await validate();
    report({ subsystem, status: 'PASS', message: 'Subsystem verified.', details });
  } catch (error) {
    report({
      subsystem,
      status: 'FAIL',
      message: errorMessage(error),
    });
  }
}

async function main(): Promise<void> {
  await Promise.all([
    runCheck('postgresql-pgvector', validatePostgres),
    runCheck('redis', validateRedis),
    runCheck('backend-api-container', validateBackend),
  ]);

  const failedChecks = checks.filter((check) => check.status === 'FAIL').length;
  report({
    subsystem: 'system',
    status: failedChecks === 0 ? 'PASS' : 'FAIL',
    message:
      failedChecks === 0
        ? 'All system verification checks passed.'
        : `${failedChecks} system verification check(s) failed.`,
    details: {
      passed: checks.filter((check) => check.status === 'PASS').length,
      failed: failedChecks,
    },
  });
  process.exitCode = failedChecks === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  report({
    subsystem: 'system',
    status: 'FAIL',
    message: `Unexpected validation error: ${errorMessage(error)}`,
  });
  process.exitCode = 1;
});
