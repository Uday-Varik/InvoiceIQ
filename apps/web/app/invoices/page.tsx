import { Suspense } from 'react';
import { Dashboard } from '../../components/dashboard';
import { PageHeader } from '../../components/page-header';

export default function InvoicesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Invoices" description="Filter by state, vendor, date or amount. Exports contain exactly what the filters show." />
      {/* The dashboard reads its filters from the URL, which needs a Suspense boundary when prerendered. */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Dashboard />
      </Suspense>
    </div>
  );
}
