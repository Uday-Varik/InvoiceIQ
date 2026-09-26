import pg from 'pg';
import { parsePolicy, type PolicyInput } from '../domain/index.js';

export const DEMO_TENANT_ID = '00000000-0000-4000-8000-00000000d3e0';

export function defaultPolicy(tenantId: string): PolicyInput {
  return {
    version: 1,
    tenantId,
    baseCurrency: 'USD',
    enabledCurrencies: ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR'],
    matching: { mode: 'three_way', priceToleranceBps: 200, quantityToleranceBps: 0 },
    duplicates: { windowDays: 365, nearMatchMaxEditDistance: 1 },
    vendorBankChange: { quarantineHours: 72, requireCallbackVerification: true },
    approvalTiers: [
      { name: 'clerk', maxAmountMinor: '100000', approverRole: 'ap_clerk' },
      { name: 'manager', maxAmountMinor: '1000000', approverRole: 'ap_manager' },
      { name: 'controller', maxAmountMinor: '10000000', approverRole: 'controller' },
      { name: 'cfo', maxAmountMinor: '100000000', approverRole: 'cfo', approvalsRequired: 2 },
    ],
    ai: { extractionConfidenceHoldBelow: 0.8, anomalyScoreHoldAbove: 0.8 },
  };
}

/**
 * Create a tenant and its policy if they do not exist. Runs as the owner role:
 * tenant creation is an operator action, never something a request can trigger.
 */
export async function bootstrapTenant(
  ownerConnectionString: string,
  tenant: { id: string; name: string; policy?: PolicyInput },
): Promise<{ created: boolean }> {
  const policy = tenant.policy ?? defaultPolicy(tenant.id);
  parsePolicy(policy); // refuse to store a policy that would not load
  const client = new pg.Client({ connectionString: ownerConnectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
    const res = await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [tenant.id, tenant.name]);
    await client.query(
      'INSERT INTO tenant_policies (tenant_id, policy) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING',
      [tenant.id, JSON.stringify(policy)],
    );
    await client.query('COMMIT');
    return { created: res.rowCount === 1 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
