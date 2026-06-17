import knexFactory, { type Knex } from 'knex';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[knex] DATABASE_URL is not set. Database operations will fail until this is configured.',
  );
}

export const knex: Knex = knexFactory({
  client: 'pg',
  connection: DATABASE_URL,
  pool: {
    min: 0,
    max: 10,
  },
});
