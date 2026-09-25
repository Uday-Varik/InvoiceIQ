import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { bootstrapTenant } from '../db/bootstrap.js';

const { values } = parseArgs({ options: { id: { type: 'string' }, name: { type: 'string' } } });
const url = process.env['MIGRATION_DATABASE_URL'];
if (!url || !values.name) {
  console.error('usage: MIGRATION_DATABASE_URL=... bootstrap-tenant --name "Acme Corp" [--id <uuid>]');
  process.exit(2);
}
const id = values.id ?? randomUUID();
const { created } = await bootstrapTenant(url, { id, name: values.name });
console.log(`${created ? 'created' : 'already exists'}: tenant ${id} (${values.name})`);
