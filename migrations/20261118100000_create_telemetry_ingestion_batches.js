exports.up = async function (knex) {
  await knex.schema.createTable('telemetry_ingestion_batches', (table) => {
    table.string('idempotency_key', 64).primary();
    table.uuid('trip_id').notNullable().references('order_id').inTable('trips').onDelete('CASCADE');
    table.uuid('driver_id').notNullable().references('driver_id').inTable('drivers');
    table.string('payload_sha256', 64).notNullable();
    table.integer('accepted_points').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.check('accepted_points > 0 AND accepted_points <= 10');
    table.index(['trip_id', 'created_at'], 'ix_telemetry_batches_trip_created');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('telemetry_ingestion_batches');
};
