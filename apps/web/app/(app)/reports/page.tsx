'use client';

import { Suspense } from 'react';
import { Reports } from '../../../components/reports';

export default function ReportsPage() {
  return (
    <section>
      <h1>Reports &amp; Analytics</h1>
      <p className="muted">Spend dashboards, approval metrics and exportable reports.</p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Reports />
      </Suspense>
    </section>
  );
}
