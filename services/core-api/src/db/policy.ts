import { parsePolicy, type Policy } from '../domain/index.js';
import type { Tx } from './pool.js';

/** The caller's tenant policy, re-validated on every load so a hand-edited row cannot weaken a floor. */
export async function loadPolicy(tx: Tx): Promise<Policy> {
  const { rows } = await tx.query<{ policy: unknown }>('SELECT policy FROM tenant_policies WHERE tenant_id = app_tenant()');
  if (!rows[0]) throw new Error('tenant has no policy; run the tenant bootstrap');
  return parsePolicy(rows[0].policy);
}
