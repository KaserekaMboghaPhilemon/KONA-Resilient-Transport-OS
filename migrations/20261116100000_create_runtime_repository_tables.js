/**
 * Runtime repository schema corresponding to TripRepository,
 * IdempotencyRepository, and DriverSecretRepository.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('trips', (table) => {
    table.uuid('order_id').primary();
    table.uuid('driver_id').notNullable().references('driver_id').inTable('drivers');
    table.text('origin').nullable();
    table.text('destination').nullable();
    table.text('status').notNullable();
    table.decimal('fare_amount', 20, 2).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['status', 'order_id'], 'ix_trips_status_order');
  });

  await knex.schema.createTable('driver_ledgers', (table) => {
    table.bigIncrements('id').primary();
    table.uuid('order_id').notNullable().references('order_id').inTable('trips');
    table.uuid('driver_id').notNullable().references('driver_id').inTable('drivers');
    table.decimal('amount', 20, 2).notNullable();
    table.text('transaction_type').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['order_id', 'created_at'], 'ix_driver_ledgers_order');
  });

  await knex.schema.createTable('processed_idempotency_keys', (table) => {
    table.text('key').primary();
    table.timestamp('processed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('driver_auth_secrets', (table) => {
    table.uuid('driver_id').primary().references('driver_id').inTable('drivers').onDelete('CASCADE');
    table.text('secret_key').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.check('length(trim(secret_key)) > 0');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('driver_auth_secrets');
  await knex.schema.dropTableIfExists('processed_idempotency_keys');
  await knex.schema.dropTableIfExists('driver_ledgers');
  await knex.schema.dropTableIfExists('trips');
};
