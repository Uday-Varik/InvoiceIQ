'use client';

import { Suspense } from 'react';
import { Reports } from '../../components/reports';

export default function ReportsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      <Reports />
    </Suspense>
  );
}
