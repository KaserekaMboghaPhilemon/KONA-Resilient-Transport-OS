import { randomUUID } from 'node:crypto';
import base45 from 'base45';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { knex } from '../../src/database/knex';
import { CryptoSignatureEngine } from '../../src/services/CryptoSignatureEngine';
import { telemetrySignaturePayload } from '../../src/utils/TelemetryAuth';

jest.setTimeout(30_000);

const describeWhenEnabled =
  process.env.KONA_RUN_INTEGRATION_TESTS === '1' ? describe : describe.skip;

describeWhenEnabled('Milestone 4 live Docker stack stress verification', () => {
  const apiBaseUrl =
    process.env.KONA_API_HEALTH_URL?.replace(/\/$/, '') || 'http://127.0.0.1:3000';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let redis: Redis;

  const created = {
    clientId: '',
    driverId: '',
    orderId: '',
    escrowId: '',
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error('DATABASE_URL and REDIS_URL are required for Milestone 4 integration tests.');
    }

    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });

    created.clientId = randomUUID();
    created.driverId = randomUUID();
    created.orderId = randomUUID();
    created.escrowId = randomUUID();
  });

  afterAll(async () => {
    await knex.transaction(async (trx) => {
      await trx('telemetry_ingestion_batches').where({ driver_id: created.driverId }).del();
      await trx('trip_telemetry_points').where({ trip_id: created.orderId }).del();
      await trx('trips').where({ order_id: created.orderId }).del();
      await trx('processed_idempotency_keys')
        .where('key', 'like', 'm4:%')
        .del();
      await trx('ledger_entries')
        .whereIn(
          'ledger_transaction_id',
          trx('ledger_transactions')
            .select('ledger_transaction_id')
            .where({ order_id: created.orderId }),
        )
        .del();
      await trx('ledger_transactions').where({ order_id: created.orderId }).del();
      await trx('booking_escrows').where({ order_id: created.orderId }).del();
      await trx('ride_orders').where({ order_id: created.orderId }).del();
      await trx('driver_auth_secrets').where({ driver_id: created.driverId }).del();
      await trx('driver_states').where({ driver_id: created.driverId }).del();
      await trx('ledger_accounts').where({ driver_id: created.driverId }).del();
      await trx('ledger_accounts').where({ client_id: created.clientId }).del();
      await trx('drivers').where({ driver_id: created.driverId }).del();
      await trx('clients').where({ client_id: created.clientId }).del();
    });

    await Promise.all([pool.end(), redis?.quit(), knex.destroy()]);
  });

  it('keeps the backend, Redis, and PostgreSQL services healthy', async () => {
    const health = await fetch(`${apiBaseUrl}/`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'success',
      message: 'KONA Transport OS API is running',
    });

    const redisKey = `kona:m4:${randomUUID()}`;
    await redis.set(redisKey, 'round-trip', 'EX', 30);
    await expect(redis.get(redisKey)).resolves.toBe('round-trip');
    await redis.del(redisKey);

    const client = await pool.connect();
    try {
      const result = await client.query<{ vector_version: string }>(
        "SELECT extversion AS vector_version FROM pg_extension WHERE extname = 'vector'",
      );
      expect(result.rows[0]?.vector_version).toBeTruthy();
    } finally {
      client.release();
    }
  });

  it('applies a booking lock once under concurrent idempotent redials', async () => {
    await knex.transaction(async (trx) => {
      await trx('clients').insert({
        client_id: created.clientId,
        full_name: 'KONA M4 Client',
        phone_e164: `+2547${String(Date.now()).slice(-9)}`,
        default_currency_code: 'USD',
      });
      await trx('drivers').insert({
        driver_id: created.driverId,
        full_name: 'KONA M4 Driver',
        phone_e164: `+2547${String(Date.now()).slice(-8)}1`,
        home_h3_cell: 'kakuma-m4',
      });
      await trx('driver_auth_secrets').insert({
        driver_id: created.driverId,
        secret_key: 'm4-live-stack-secret',
      });
      await trx('ledger_accounts').insert([
        {
          ledger_account_id: randomUUID(),
          account_type: 'client_payment_node',
          currency_code: 'USD',
          client_id: created.clientId,
          account_name: 'M4 Client Funds',
          current_balance_minor: 10_000,
          is_active: true,
        },
        {
          ledger_account_id: randomUUID(),
          account_type: 'driver_storage_wallet',
          currency_code: 'USD',
          driver_id: created.driverId,
          account_name: 'M4 Driver Escrow',
          current_balance_minor: 0,
          is_active: true,
        },
      ]);
      await trx('ride_orders').insert({
        order_id: created.orderId,
        client_id: created.clientId,
        active_driver_id: null,
        status: 'pending_payment',
        requested_h3_cell: 'kakuma-m4',
        destination_h3_cell: 'kakuma-market',
        quoted_fare_minor: 1_000,
        currency_code: 'USD',
        driver_share_bps: 8000,
        kona_commission_bps: 2000,
      });

      const source = await trx('ledger_accounts')
        .where({ client_id: created.clientId, account_type: 'client_payment_node' })
        .first<{ ledger_account_id: string }>();
      const target = await trx('ledger_accounts')
        .where({ driver_id: created.driverId, account_type: 'driver_storage_wallet' })
        .first<{ ledger_account_id: string }>();
      if (!source || !target) throw new Error('M4 ledger accounts were not created.');

      await trx('trips').insert({
        order_id: created.orderId,
        driver_id: created.driverId,
        origin: 'Kakuma',
        destination: 'Kakuma Market',
        status: 'ACTIVE',
      });
      await trx('booking_escrows').insert({
        escrow_id: created.escrowId,
        order_id: created.orderId,
        source_client_payment_account_id: source.ledger_account_id,
        target_driver_storage_wallet_account_id: target.ledger_account_id,
        locked_amount_minor: 1_000,
        currency_code: 'USD',
        status: 'locked',
        timeout_at: new Date(Date.now() + 60 * 60 * 1000),
      });
    });

    const idem = `m4:${randomUUID()}`;
    const action = {
      idempotency_key: idem,
      action_type: 'BOOKING_LOCK',
      payload: {
        order_id: created.orderId,
        driver_id: created.driverId,
        currency_code: 'USD',
        fare_minor: 1_000,
        driver_share_bps: 8000,
        kona_commission_bps: 2000,
      },
    };
    const rawWire = JSON.stringify(action);
    const signature = await CryptoSignatureEngine.generateSignature(
      rawWire,
      'm4-live-stack-secret',
    );
    const signedAction = {
      ...action,
      __kona_signature_hex: signature,
      __kona_raw_wire: rawWire,
    };

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        fetch(`${apiBaseUrl}/api/v1/sync/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(signedAction),
          signal: AbortSignal.timeout(10_000),
        }),
      ),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    const state = await knex.transaction(async (trx) => {
      const order = await trx('ride_orders')
        .where({ order_id: created.orderId })
        .first<{ status: string }>();
      const escrow = await trx('booking_escrows')
        .where({ escrow_id: created.escrowId })
        .first<{ status: string }>();
      const transactions = await trx('ledger_transactions')
        .where({ order_id: created.orderId, transaction_type: 'booking_lock' });
      const entries = await trx('ledger_entries')
        .join(
          'ledger_transactions',
          'ledger_transactions.ledger_transaction_id',
          'ledger_entries.ledger_transaction_id',
        )
        .where({ 'ledger_transactions.order_id': created.orderId });
      const duplicate = await trx('processed_idempotency_keys').where({ key: idem }).first();
      return { order, escrow, transactions, entries, duplicate };
    });

    expect(state.order?.status).toBe('escrow_locked');
    expect(state.escrow?.status).toBe('locked');
    expect(state.transactions).toHaveLength(1);
    expect(state.entries).toHaveLength(2);
    expect(state.duplicate).toBeTruthy();

    const balance = state.entries.reduce((sum, entry) => {
      const amount = Number(entry.amount_minor);
      return sum + (entry.entry_side === 'debit' ? amount : -amount);
    }, 0);
    expect(balance).toBe(0);
  });

  it('accepts repeated telemetry delivery once under concurrent redials', async () => {
    const secret = 'm4-live-stack-secret';
    const timestamp = Date.now();
    const telemetryIdempotencyKey =
      randomUUID().replace(/-/g, '').slice(0, 32).padEnd(64, 'b');
    const body = {
      trip_id: created.orderId,
      payload_b45: base45.encode(
        Buffer.from(`${created.orderId}|1.2345000,2.3456000,5.25,${timestamp}`),
      ),
      point_count: 1,
      idempotency_key: telemetryIdempotencyKey,
    };
    const signature = await CryptoSignatureEngine.generateStrongSignature(
      telemetrySignaturePayload(body),
      secret,
    );

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        fetch(`${apiBaseUrl}/api/v1/telemetry/batch`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-kona-driver-id': created.driverId,
            'x-kona-signature': signature,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        }),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: 'ok',
        acceptedPoints: 1,
      });
    }

    const persisted = await knex('trip_telemetry_points')
      .where({ trip_id: created.orderId });
    const batches = await knex('telemetry_ingestion_batches')
      .where({ idempotency_key: body.idempotency_key });
    expect(persisted).toHaveLength(1);
    expect(batches).toHaveLength(1);
  });

  it('rolls back idempotency and domain writes when a live transaction violates a constraint', async () => {
    const key = `m4:${randomUUID()}`;
    await expect(
      knex.transaction(async (trx) => {
        await trx('processed_idempotency_keys').insert({ key });
        await trx('trips').insert({
          order_id: created.orderId,
          driver_id: created.driverId,
          status: 'DUPLICATE_VIOLATION',
        });
      }),
    ).rejects.toThrow();

    await expect(
      knex('processed_idempotency_keys').where({ key }).first(),
    ).resolves.toBeUndefined();
  });
});
