'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listInvoices, type Invoice } from '../lib/api';
import { formatMoney, STATE_LABEL } from '../lib/format';
import { useBackend } from './backend';

export function InvoiceList() {
  const backend = useBackend();
  const [items, setItems] = useState<readonly Invoice[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (backend !== 'ready') return;
    listInvoices().then(
      (page) => setItems(page.items),
      () => setError(true),
    );
  }, [backend]);

  if (error) return <p className="muted">Could not load recent invoices.</p>;
  if (!items) return null;
  if (items.length === 0) return <p className="muted">No invoices yet.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Invoice</th>
          <th>Vendor</th>
          <th className="num">Total</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {items.map((inv) => (
          <tr key={inv.id}>
            <td>
              <Link href={`/invoices/${inv.id}`}>{inv.invoiceNumber ?? inv.document?.filename ?? inv.id.slice(0, 8)}</Link>
            </td>
            <td>{inv.vendorName ?? '—'}</td>
            <td className="num">{inv.total ? formatMoney(inv.total.amountMinor, inv.total.currency) : '—'}</td>
            <td>
              <span className={`pill pill-${inv.state.toLowerCase()}`}>{STATE_LABEL[inv.state]}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
