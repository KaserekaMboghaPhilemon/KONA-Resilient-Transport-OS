/**
 * Runtime repository schema corresponding to TripRepository,
 * IdempotencyRepository, and DriverSecretRepository.
 *
 * SPRINT1_SCHEMA.sql is the canonical source for these shared tables. This
 * migration creates missing tables for older installations but does not drop
 * shared data during rollback.
 */
async function tableHasColumns(knex, tableName, columns) {
  if (!(await knex.schema.hasTable(tableName))) {
    return false;
  }

  const missingColumns = [];
  for (const column of columns) {
    if (!(await knex.schema.hasColumn(tableName, column))) {
      missingColumns.push(column);
    }
  }
  if (missingColumns.length > 0) {
    throw new Error(
      `Existing table "${tableName}" is missing required columns: ${missingColumns.join(', ')}.`,
    );
  }
  return true;
}

exports.up = async function (knex) {
  if (!(await tableHasColumns(knex, 'trips', [
    'order_id', 'driver_id', 'origin', 'destination', 'status', 'fare_amount', 'created_at', 'updated_at',
  ]))) {
    await knex.schema.createTable('trips', (table) => {
      table.uuid('order_id').primary();
      table.uuid('driver_id').notNullable().references('driver_id').inTable('drivers');
      table.text('origin').nullable();
      table.text('destination').nullable();
      table.text('status').notNullable();
      table.decimal('fare_amount', 20, 2).nullable();
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS ix_trips_status_order ON trips (status, order_id)');

  if (!(await tableHasColumns(knex, 'driver_ledgers', [
    'id', 'order_id', 'driver_id', 'amount', 'transaction_type', 'created_at',
  ]))) {
    await knex.schema.createTable('driver_ledgers', (table) => {
      table.bigIncrements('id').primary();
      table.uuid('order_id').notNullable().references('order_id').inTable('trips');
      table.uuid('driver_id').notNullable().references('driver_id').inTable('drivers');
      table.decimal('amount', 20, 2).notNullable();
      table.text('transaction_type').notNullable();
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS ix_driver_ledgers_order ON driver_ledgers (order_id, created_at)');

  if (!(await tableHasColumns(knex, 'processed_idempotency_keys', ['key', 'processed_at']))) {
    await knex.schema.createTable('processed_idempotency_keys', (table) => {
      table.text('key').primary();
      table.timestamp('processed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  if (!(await tableHasColumns(knex, 'driver_auth_secrets', ['driver_id', 'secret_key', 'created_at']))) {
    await knex.schema.createTable('driver_auth_secrets', (table) => {
      table.uuid('driver_id').primary().references('driver_id').inTable('drivers').onDelete('CASCADE');
      table.text('secret_key').notNullable();
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.check('length(trim(secret_key)) > 0');
    });
  }
};

exports.down = async function () {
  // These tables are shared with SPRINT1_SCHEMA.sql and may contain production data.
};
