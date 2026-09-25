import { migrate } from '../db/migrate.js';

const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) {
  console.error('MIGRATION_DATABASE_URL is required');
  process.exit(2);
}
const applied = await migrate(url);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema is up to date');
