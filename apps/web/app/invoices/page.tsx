import { Suspense } from 'react';
import { Dashboard } from '../../components/dashboard';

export default function InvoicesPage() {
  return (
    <section>
      <h1>Invoices</h1>
      <p className="muted">Filter by state, vendor, date or amount. Exports contain exactly what the filters show.</p>
      {/* The dashboard reads its filters from the URL, which needs a Suspense boundary when prerendered. */}
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Dashboard />
      </Suspense>
    </section>
  );
}
