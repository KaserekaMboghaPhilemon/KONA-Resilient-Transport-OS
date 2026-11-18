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
  if (!(await tableHasColumns(knex, 'trip_telemetry_points', [
    'id', 'trip_id', 'latitude', 'longitude', 'speed', 'timestamp',
  ]))) {
    await knex.schema.createTable('trip_telemetry_points', (table) => {
      table.bigIncrements('id').primary();
      table.uuid('trip_id').notNullable().references('order_id').inTable('trips').onDelete('CASCADE');
      table.decimal('latitude', 10, 7).notNullable();
      table.decimal('longitude', 10, 7).notNullable();
      table.decimal('speed', 10, 2).nullable();
      table.bigInteger('timestamp').notNullable();
      table.check('latitude BETWEEN -90 AND 90');
      table.check('longitude BETWEEN -180 AND 180');
      table.check('speed IS NULL OR speed >= 0');
    });
  }
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS ix_trip_telemetry_trip_timestamp ON trip_telemetry_points (trip_id, timestamp)',
  );
};

exports.down = async function () {
  // This table is shared with SPRINT1_SCHEMA.sql; retain its data on rollback.
};
