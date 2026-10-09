'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { exportUrl, getSummary, listInvoices, type Invoice, type InvoiceState, type InvoiceSummary } from '../lib/api';
import { INVOICE_STATES } from '../lib/catalog';
import {
  activeFilterCount,
  EMPTY_FILTERS,
  filtersFromSearch,
  filtersToQuery,
  filtersToSearch,
  validateFilters,
  type DashboardFilters,
} from '../lib/filters';
import { formatMoney, STATE_LABEL } from '../lib/format';
import { cn } from '../lib/utils';
import { useBackend } from './backend';
import { Badge } from './ui/badge';
import { Button, buttonVariants } from './ui/button';
import { Card } from './ui/card';
import { inputClass } from './ui/field';
import { StatusBadge } from './ui/status-badge';
import { Table, TableCell, TableHead, TableRow } from './ui/table';

const PAGE_SIZE = 25;
/** The states a reviewer acts on, shown as headline cards. */
const HEADLINE: readonly InvoiceState[] = ['PENDING_APPROVAL', 'HOLD', 'EXCEPTION', 'APPROVED'];

export function Dashboard() {
  const backend = useBackend();
  const search = useSearchParams();
  const [draft, setDraft] = useState<DashboardFilters>(() => filtersFromSearch(search.toString()));
  const [applied, setApplied] = useState<DashboardFilters>(draft);
  const [items, setItems] = useState<readonly Invoice[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<InvoiceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = filtersToQuery(applied);
  const errors = validateFilters(draft);

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      setError(null);
      try {
        const [page, sum] = await Promise.all([listInvoices(query, { limit: PAGE_SIZE, ...(after ? { cursor: after } : {}) }), after ? undefined : getSummary(query)]);
        setItems((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        if (sum) setSummary(sum);
      } catch {
        setError('Could not load invoices.');
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    if (backend === 'ready') void load();
  }, [backend, load]);

  function apply(next: DashboardFilters) {
    setApplied(next);
    const qs = filtersToSearch(next);
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (Object.keys(errors).length === 0) apply(draft);
  }

  const field = (key: keyof DashboardFilters) => ({
    value: draft[key],
    onChange: (e: { target: { value: string } }) => setDraft({ ...draft, [key]: e.target.value }),
    'aria-invalid': errors[key] ? true : undefined,
  });

  return (
    <div className="space-y-6">
      {summary && <SummaryCards summary={summary} onPick={(state) => apply({ ...applied, state })} active={applied.state} />}

      <form className="grid gap-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4" onSubmit={onSubmit} aria-label="Filter invoices">
        <Field label="Search" className="sm:col-span-2">
          <input type="search" className={inputClass} placeholder="Vendor, invoice number or file" maxLength={100} {...field('q')} />
        </Field>
        <Field label="State">
          <select className={inputClass} {...field('state')}>
            <option value="">Any</option>
            {INVOICE_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s as InvoiceState]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Currency" error={errors.currency}>
          <input className={inputClass} placeholder="USD" maxLength={3} {...field('currency')} />
        </Field>
        <Field label="Invoice date from" error={errors.dateFrom}>
          <input type="date" className={inputClass} {...field('dateFrom')} />
        </Field>
        <Field label="Invoice date to" error={errors.dateTo}>
          <input type="date" className={inputClass} {...field('dateTo')} />
        </Field>
        <Field label="Total from" error={errors.minTotal}>
          <input inputMode="decimal" className={inputClass} placeholder="0.00" {...field('minTotal')} />
        </Field>
        <Field label="Total to" error={errors.maxTotal}>
          <input inputMode="decimal" className={inputClass} placeholder="0.00" {...field('maxTotal')} />
        </Field>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit" disabled={Object.keys(errors).length > 0}>
            Apply filters
          </Button>
          {activeFilterCount(applied) > 0 && (
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(EMPTY_FILTERS);
                apply(EMPTY_FILTERS);
              }}
            >
              Clear
            </Button>
          )}
          <span className="flex-1" />
          <a className={buttonVariants({ variant: 'outline' })} href={exportUrl('csv', query)} download>
            Export CSV
          </a>
          <a className={buttonVariants({ variant: 'outline' })} href={exportUrl('json', query)} download>
            Export JSON
          </a>
        </div>
      </form>

      {error && <ErrorLine message={error} />}
      {items && items.length === 0 && !loading && <p className="text-sm text-muted-foreground">No invoices match these filters.</p>}
      {items && items.length > 0 && (
        <Card className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <TableHead>Invoice</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Invoice date</TableHead>
                <TableHead>Due</TableHead>
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
                    {inv.corrections && inv.corrections.length > 0 && (
                      <Badge className="ml-2" title={`Corrected: ${inv.corrections.join(', ')}`}>
                        edited
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{inv.vendorName ?? <span className="text-muted-foreground">Vendor not found</span>}</TableCell>
                  <TableCell className="tabular-nums">{inv.invoiceDate ?? '—'}</TableCell>
                  <TableCell className="tabular-nums">{inv.dueDate ?? '—'}</TableCell>
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
        </Card>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {cursor && (
          <Button variant="outline" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        )}
        {items && <span className="text-sm text-muted-foreground">{summary ? `Showing ${items.length} of ${summary.count}` : `Showing ${items.length}`}</span>}
      </div>
    </div>
  );
}

function Field({ label, error, className, children }: { label: string; error?: string | undefined; className?: string | undefined; children: ReactNode }) {
  return (
    <label className={cn('grid gap-1 text-sm', className)}>
      <span className="font-medium text-foreground">{label}</span>
      {children}
      {error && <span className="text-xs text-rose-700 dark:text-rose-300">{error}</span>}
    </label>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
      {message}
    </p>
  );
}

function SummaryCards({ summary, onPick, active }: { summary: InvoiceSummary; onPick: (state: InvoiceState | '') => void; active: string }) {
  const count = (s: InvoiceState) => summary.byState.find((r) => r.state === s)?.count ?? 0;
  const tile = 'flex flex-col items-start gap-1 p-4 text-left transition-colors hover:bg-muted/50';
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <button type="button" aria-pressed={active === ''} onClick={() => onPick('')} className={cn('rounded-xl', active === '' && 'ring-2 ring-ring')}>
        <Card className={tile}>
          <span className="text-2xl font-semibold tabular-nums">{summary.count}</span>
          <span className="text-sm text-muted-foreground">All invoices</span>
        </Card>
      </button>
      {HEADLINE.map((s) => (
        <button key={s} type="button" aria-pressed={active === s} onClick={() => onPick(s)} className={cn('rounded-xl', active === s && 'ring-2 ring-ring')}>
          <Card className={tile}>
            <StatusBadge state={s} />
            <span className="text-2xl font-semibold tabular-nums">{count(s)}</span>
          </Card>
        </button>
      ))}
      {summary.byCurrency.map((c) => (
        <Card key={c.currency} className="flex flex-col gap-1 p-4" title={`${c.count} invoice${c.count === 1 ? '' : 's'}`}>
          <span className="text-2xl font-semibold tabular-nums">{formatMoney(c.amountMinor, c.currency)}</span>
          <span className="text-sm text-muted-foreground">
            Total in {c.currency} ({c.count})
          </span>
        </Card>
      ))}
    </div>
  );
}
