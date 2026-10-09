'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listInvoices, type Invoice } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useBackend } from './backend';
import { StatusBadge } from './ui/status-badge';
import { Table, TableCell, TableHead, TableRow } from './ui/table';

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

  if (error) return <p className="p-4 text-sm text-muted-foreground">Could not load recent invoices.</p>;
  if (!items) return null;
  if (items.length === 0) return <p className="p-4 text-sm text-muted-foreground">No invoices yet. Upload one to start.</p>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <thead>
          <tr>
            <TableHead>Invoice</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>State</TableHead>
          </tr>
        </thead>
        <tbody>
          {items.map((inv) => (
            <TableRow key={inv.id}>
              <TableCell>
                <Link href={`/invoices/${inv.id}`} className="font-medium text-primary hover:underline">
                  {inv.invoiceNumber ?? inv.document?.filename ?? inv.id.slice(0, 8)}
                </Link>
              </TableCell>
              <TableCell>{inv.vendorName ?? <span className="text-muted-foreground">Vendor not found</span>}</TableCell>
              <TableCell className="text-right tabular-nums">
                {inv.total ? formatMoney(inv.total.amountMinor, inv.total.currency) : '—'}
              </TableCell>
              <TableCell>
                <StatusBadge state={inv.state} />
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
