exports.up = async function (knex) {
  await knex.schema.createTable('trip_telemetry_points', (table) => {
    table.bigIncrements('id').primary();
    table.uuid('trip_id').notNullable().references('order_id').inTable('trips').onDelete('CASCADE');
    table.decimal('latitude', 10, 7).notNullable();
    table.decimal('longitude', 10, 7).notNullable();
    table.decimal('speed', 10, 2).nullable();
    table.bigInteger('timestamp').notNullable();
    table.index(['trip_id', 'timestamp'], 'ix_trip_telemetry_trip_timestamp');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('trip_telemetry_points');
};
