async function tableHasColumns(knex, tableName, columns) {
  if (!(await knex.schema.hasTable(tableName))) {
    return false;
  }
  for (const column of columns) {
    if (!(await knex.schema.hasColumn(tableName, column))) {
      throw new Error(`Existing table "${tableName}" is missing required column "${column}".`);
    }
  }
  return true;
}

exports.up = async function (knex) {
  if (!(await tableHasColumns(knex, 'telemetry_ingestion_batches', [
    'idempotency_key', 'trip_id', 'driver_id', 'payload_sha256', 'accepted_points', 'created_at',
  ]))) {
    await knex.schema.createTable('telemetry_ingestion_batches', (table) => {
      table.string('idempotency_key', 64).primary();
      table.uuid('trip_id').notNullable().references('order_id').inTable('trips').onDelete('CASCADE');
      table.uuid('driver_id').notNullable().references('driver_id').inTable('drivers');
      table.string('payload_sha256', 64).notNullable();
      table.integer('accepted_points').notNullable();
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.check('accepted_points > 0 AND accepted_points <= 10');
    });
  }
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS ix_telemetry_batches_trip_created ON telemetry_ingestion_batches (trip_id, created_at)',
  );
};

exports.down = async function () {
  // The ingestion table is part of the canonical SQL schema; retain its data.
};
