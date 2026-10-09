'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  exportUrl,
  getSummary,
  listInvoices,
  listPaymentRuns,
  listVendors,
  type Invoice,
  type InvoiceState,
  type InvoiceSummary,
  type PaymentRun,
  type Vendor,
} from '../lib/api';
import { formatMoney, STATE_LABEL } from '../lib/format';
import { cn } from '../lib/utils';
import { useBackend } from './backend';
import { PageHeader } from './page-header';
import { Button, buttonVariants } from './ui/button';
import { Card } from './ui/card';
import { Table, TableCell, TableHead, TableRow } from './ui/table';

type Tab = 'overview' | 'vendors' | 'approvals';

const TAB_LABEL: Record<Tab, string> = { overview: 'Overview', vendors: 'Spend by vendor', approvals: 'Approval metrics' };

const INVOICE_PAGE_SIZE = 200;
const INVOICE_PAGE_LIMIT = 5;

/** The API caps a page at 200, so the report reads up to five pages (1,000 invoices). */
async function listAllInvoices(): Promise<readonly Invoice[]> {
  const items: Invoice[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < INVOICE_PAGE_LIMIT; page++) {
    const next = await listInvoices('', { limit: INVOICE_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    items.push(...next.items);
    cursor = next.nextCursor;
    if (!cursor) break;
  }
  return items;
}

export function Reports() {
  const backend = useBackend();
  const [tab, setTab] = useState<Tab>('overview');
  const [summary, setSummary] = useState<InvoiceSummary | null>(null);
  const [invoices, setInvoices] = useState<readonly Invoice[]>([]);
  const [vendors, setVendors] = useState<readonly Vendor[]>([]);
  const [runs, setRuns] = useState<readonly PaymentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sum, all, vl, rl] = await Promise.all([getSummary(), listAllInvoices(), listVendors(), listPaymentRuns()]);
      setSummary(sum);
      setInvoices(all);
      setVendors(vl.items);
      setRuns(rl.items);
    } catch {
      setError('Could not load report data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (backend === 'ready') void load();
  }, [backend, load]);

  if (backend !== 'ready') return <p className="text-sm text-muted-foreground">Connecting…</p>;
  if (loading) return <p className="text-sm text-muted-foreground">Loading report data…</p>;
  if (error)
    return (
      <Card role="alert" className="flex flex-wrap items-center justify-between gap-4 border-rose-200 bg-rose-50 p-5 dark:border-rose-400/30 dark:bg-rose-400/10">
        <div>
          <p className="font-semibold text-rose-900 dark:text-rose-200">Reports could not load</p>
          <p className="text-sm text-rose-800 dark:text-rose-300">{error} Your invoices are safe. Try again in a moment.</p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description="Spend, approval outcomes and exports." />

      <div role="tablist" className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        {(['overview', 'vendors', 'approvals'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              tab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === 'overview' && summary && <OverviewPanel summary={summary} invoices={invoices} runs={runs} />}
      {tab === 'vendors' && <VendorSpendPanel invoices={invoices} vendors={vendors} />}
      {tab === 'approvals' && <ApprovalMetricsPanel invoices={invoices} />}

      <div className="flex flex-wrap gap-2">
        <a className={buttonVariants({ variant: 'outline' })} href={exportUrl('csv')} download>
          Export all invoices (CSV)
        </a>
        <a className={buttonVariants({ variant: 'outline' })} href={exportUrl('json')} download>
          Export all invoices (JSON)
        </a>
      </div>
    </div>
  );
}

/* ─── Overview ─── */

function OverviewPanel({
  summary,
  invoices,
  runs,
}: {
  summary: InvoiceSummary;
  invoices: readonly Invoice[];
  runs: readonly PaymentRun[];
}) {
  const approvedCount = summary.byState.find((s) => s.state === 'APPROVED')?.count ?? 0;
  const rejectedCount = summary.byState.find((s) => s.state === 'REJECTED')?.count ?? 0;
  const pendingCount = summary.byState.find((s) => s.state === 'PENDING_APPROVAL')?.count ?? 0;
  const paidCount = summary.byState.find((s) => s.state === 'PAID')?.count ?? 0;
  const completedRuns = runs.filter((r) => r.status === 'paid').length;

  return (
    <div className="space-y-6">
      <KpiRow>
        <KpiCard label="Total invoices" value={String(summary.count)} />
        <KpiCard label="Approved" value={String(approvedCount)} tone="ok" />
        <KpiCard label="Rejected" value={String(rejectedCount)} tone="bad" />
        <KpiCard label="Pending" value={String(pendingCount)} tone="warn" />
        <KpiCard label="Paid" value={String(paidCount)} tone="ok" />
        <KpiCard label="Payment runs" value={String(completedRuns)} />
      </KpiRow>

      <div className="grid gap-4 lg:grid-cols-3">
        <ReportCard title="Invoice volume by state">
          <BarChart
            data={summary.byState.map((s) => ({
              label: STATE_LABEL[s.state as InvoiceState] ?? s.state,
              value: s.count,
            }))}
          />
        </ReportCard>
        <ReportCard title="Value by currency">
          {summary.byCurrency.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoice data yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <TableHead>Currency</TableHead>
                  <TableHead className="text-right">Invoices</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </tr>
              </thead>
              <tbody>
                {summary.byCurrency.map((c) => (
                  <TableRow key={c.currency}>
                    <TableCell>{c.currency}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.count}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(c.amountMinor, c.currency)}</TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          )}
        </ReportCard>
        <ReportCard title="Processing pipeline">
          <PipelineChart invoices={invoices} />
        </ReportCard>
      </div>
    </div>
  );
}

/* ─── Spend by Vendor ─── */

interface VendorSpend {
  name: string;
  count: number;
  totalsByCurrency: Record<string, number>;
}

function VendorSpendPanel({ invoices, vendors }: { invoices: readonly Invoice[]; vendors: readonly Vendor[] }) {
  const vendorSpend = useMemo(() => {
    const map = new Map<string, VendorSpend>();
    for (const inv of invoices) {
      const name = inv.vendorName ?? 'Unknown';
      let entry = map.get(name);
      if (!entry) {
        entry = { name, count: 0, totalsByCurrency: {} };
        map.set(name, entry);
      }
      entry.count++;
      if (inv.total) {
        const cur = inv.total.currency;
        entry.totalsByCurrency[cur] = (entry.totalsByCurrency[cur] ?? 0) + Number(inv.total.amountMinor);
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [invoices]);

  const maxCount = Math.max(...vendorSpend.map((v) => v.count), 1);

  return (
    <div className="space-y-6">
      <KpiRow>
        <KpiCard label="Active vendors" value={String(vendors.filter((v) => v.status === 'active').length)} />
        <KpiCard label="Unique vendors (invoiced)" value={String(vendorSpend.length)} />
      </KpiRow>
      <ReportCard title="Top vendors by invoice count">
        {vendorSpend.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoice data yet.</p>
        ) : (
          <div className="space-y-2">
            {vendorSpend.slice(0, 15).map((v) => (
              <div key={v.name} className="grid grid-cols-[minmax(0,10rem)_1fr_2.5rem] items-center gap-3 text-sm">
                <span className="truncate" title={v.name}>
                  {v.name}
                </span>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(v.count / maxCount) * 100}%` }} />
                </div>
                <span className="text-right tabular-nums">{v.count}</span>
              </div>
            ))}
          </div>
        )}
      </ReportCard>
      <ReportCard title="Spend by vendor">
        {vendorSpend.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Invoices</TableHead>
                <TableHead className="text-right">Spend</TableHead>
              </tr>
            </thead>
            <tbody>
              {vendorSpend.map((v) => (
                <TableRow key={v.name}>
                  <TableCell>{v.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{v.count}</TableCell>
                  <TableCell className="space-x-2 text-right tabular-nums">
                    {Object.entries(v.totalsByCurrency).map(([cur, minor]) => (
                      <span key={cur}>{formatMoney(String(minor), cur)}</span>
                    ))}
                    {Object.keys(v.totalsByCurrency).length === 0 && '—'}
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </ReportCard>
    </div>
  );
}

/* ─── Approval Metrics ─── */

function ApprovalMetricsPanel({ invoices }: { invoices: readonly Invoice[] }) {
  const metrics = useMemo(() => {
    const total = invoices.length;
    const approved = invoices.filter((i) => i.state === 'APPROVED' || i.state === 'PAYMENT_QUEUED' || i.state === 'PAID').length;
    const rejected = invoices.filter((i) => i.state === 'REJECTED').length;
    const onHold = invoices.filter((i) => i.state === 'HOLD').length;
    const exception = invoices.filter((i) => i.state === 'EXCEPTION').length;
    const pending = invoices.filter((i) => i.state === 'PENDING_APPROVAL').length;
    const approvalRate = total > 0 ? ((approved / total) * 100).toFixed(1) : '0';
    const rejectionRate = total > 0 ? ((rejected / total) * 100).toFixed(1) : '0';
    const holdRate = total > 0 ? (((onHold + exception) / total) * 100).toFixed(1) : '0';
    return { total, approved, rejected, onHold, exception, pending, approvalRate, rejectionRate, holdRate };
  }, [invoices]);

  return (
    <div className="space-y-6">
      <KpiRow>
        <KpiCard label="Approval rate" value={`${metrics.approvalRate}%`} tone="ok" />
        <KpiCard label="Rejection rate" value={`${metrics.rejectionRate}%`} tone="bad" />
        <KpiCard label="Hold/exception rate" value={`${metrics.holdRate}%`} tone="warn" />
        <KpiCard label="Pending review" value={String(metrics.pending)} />
      </KpiRow>
      <div className="grid gap-4 lg:grid-cols-2">
        <ReportCard title="Approval funnel">
          <FunnelChart
            steps={[
              { label: 'Received', value: metrics.total },
              { label: 'Approved', value: metrics.approved },
              { label: 'Rejected', value: metrics.rejected },
              { label: 'On hold', value: metrics.onHold },
              { label: 'Exception', value: metrics.exception },
            ]}
          />
        </ReportCard>
        <ReportCard title="Outcome breakdown">
          <DonutChart
            segments={[
              { label: 'Approved', value: metrics.approved, color: '#059669' },
              { label: 'Rejected', value: metrics.rejected, color: '#e11d48' },
              { label: 'Hold', value: metrics.onHold, color: '#f59e0b' },
              { label: 'Exception', value: metrics.exception, color: '#ea580c' },
              { label: 'Pending', value: metrics.pending, color: '#a1a1aa' },
            ]}
          />
        </ReportCard>
      </div>
    </div>
  );
}

/* ─── Shared chart components ─── */

function ReportCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-4 p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </Card>
  );
}

function KpiRow({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

const KPI_TONE: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'text-emerald-700 dark:text-emerald-300',
  warn: 'text-amber-700 dark:text-amber-300',
  bad: 'text-rose-700 dark:text-rose-300',
};

function KpiCard({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className={cn('text-2xl font-semibold tabular-nums', tone && KPI_TONE[tone])}>{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </Card>
  );
}

function BarChart({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.label} className="grid grid-cols-[minmax(0,7rem)_1fr_2rem] items-center gap-3 text-sm">
          <span className="truncate text-muted-foreground">{d.label}</span>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
          <span className="text-right tabular-nums">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function PipelineChart({ invoices }: { invoices: readonly Invoice[] }) {
  const stages: InvoiceState[] = ['RECEIVED', 'EXTRACTING', 'VALIDATING', 'PENDING_APPROVAL', 'APPROVED', 'PAID'];
  const counts = stages.map((s) => ({ label: STATE_LABEL[s], value: invoices.filter((i) => i.state === s).length }));
  const max = Math.max(...counts.map((c) => c.value), 1);
  return (
    <div className="flex h-56 items-end gap-2">
      {counts.map((c) => (
        <div key={c.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
          <span className="text-xs tabular-nums text-muted-foreground">{c.value}</span>
          <div className="w-full rounded-t bg-primary/80" style={{ height: `${Math.max((c.value / max) * 100, 4)}%` }} />
          <span className="text-center text-[11px] leading-tight text-muted-foreground [overflow-wrap:anywhere]">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

function FunnelChart({ steps }: { steps: { label: string; value: number }[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="space-y-2">
      {steps.map((step) => (
        <div
          key={step.label}
          className="flex items-center justify-between rounded-md bg-primary/15 px-3 py-2 text-sm"
          style={{ width: `${Math.max((step.value / max) * 100, 20)}%` } as CSSProperties}
        >
          <span>{step.label}</span>
          <span className="font-semibold tabular-nums">{step.value}</span>
        </div>
      ))}
    </div>
  );
}

interface Segment {
  label: string;
  value: number;
  color: string;
}

function DonutChart({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return <p className="text-sm text-muted-foreground">No data.</p>;

  let cumulative = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((seg) => {
      const pct = (seg.value / total) * 100;
      const start = cumulative;
      cumulative += pct;
      return { ...seg, pct, start };
    });

  const gradientStops = arcs.map((a) => `${a.color} ${a.start}% ${a.start + a.pct}%`).join(', ');

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div
        className="grid size-36 shrink-0 place-items-center rounded-full"
        style={{ background: `conic-gradient(${gradientStops})` }}
        role="img"
        aria-label={`Outcome: ${arcs.map((a) => `${a.label} ${a.pct.toFixed(0)}%`).join(', ')}`}
      >
        <div className="grid size-20 place-items-center rounded-full bg-card text-center">
          <span className="text-lg font-semibold tabular-nums">{total}</span>
          <span className="text-[11px] text-muted-foreground">total</span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-2 text-sm">
        {arcs.map((a) => (
          <li key={a.label} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: a.color }} />
            <span>{a.label}</span>
            <span className="ml-auto text-muted-foreground tabular-nums">
              {a.value} ({a.pct.toFixed(0)}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
