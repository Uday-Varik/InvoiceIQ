'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useBackend } from './backend';

type Tab = 'overview' | 'vendors' | 'approvals';

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
      const [sum, page, vl, rl] = await Promise.all([
        getSummary(),
        listInvoices('', { limit: 500 }),
        listVendors(),
        listPaymentRuns(),
      ]);
      setSummary(sum);
      setInvoices(page.items);
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

  if (backend !== 'ready') return <p className="muted">Connecting…</p>;
  if (loading) return <p className="muted">Loading report data…</p>;
  if (error) return <p className="error">{error}</p>;

  return (
    <div className="reports">
      <div className="report-tabs" role="tablist">
        {(['overview', 'vendors', 'approvals'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`report-tab${tab === t ? ' report-tab-active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'overview' ? 'Overview' : t === 'vendors' ? 'Spend by Vendor' : 'Approval Metrics'}
          </button>
        ))}
      </div>

      {tab === 'overview' && summary && <OverviewPanel summary={summary} invoices={invoices} runs={runs} />}
      {tab === 'vendors' && <VendorSpendPanel invoices={invoices} vendors={vendors} />}
      {tab === 'approvals' && <ApprovalMetricsPanel invoices={invoices} />}

      <div className="report-export">
        <a className="btn" href={exportUrl('csv')} download>Export all invoices (CSV)</a>
        <a className="btn" href={exportUrl('json')} download>Export all invoices (JSON)</a>
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
    <div className="report-panel">
      <div className="report-kpi-row">
        <KpiCard label="Total invoices" value={String(summary.count)} />
        <KpiCard label="Approved" value={String(approvedCount)} tone="ok" />
        <KpiCard label="Rejected" value={String(rejectedCount)} tone="bad" />
        <KpiCard label="Pending" value={String(pendingCount)} tone="warn" />
        <KpiCard label="Paid" value={String(paidCount)} tone="ok" />
        <KpiCard label="Payment runs" value={String(completedRuns)} />
      </div>

      <div className="report-grid">
        <div className="report-card">
          <h3>Invoice volume by state</h3>
          <BarChart
            data={summary.byState.map((s) => ({
              label: STATE_LABEL[s.state as InvoiceState] ?? s.state,
              value: s.count,
            }))}
          />
        </div>
        <div className="report-card">
          <h3>Value by currency</h3>
          {summary.byCurrency.length === 0 ? (
            <p className="muted">No invoice data yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Currency</th><th className="num">Invoices</th><th className="num">Total</th></tr>
              </thead>
              <tbody>
                {summary.byCurrency.map((c) => (
                  <tr key={c.currency}>
                    <td>{c.currency}</td>
                    <td className="num">{c.count}</td>
                    <td className="num">{formatMoney(c.amountMinor, c.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="report-card">
          <h3>Processing pipeline</h3>
          <PipelineChart invoices={invoices} />
        </div>
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
    <div className="report-panel">
      <div className="report-kpi-row">
        <KpiCard label="Active vendors" value={String(vendors.filter((v) => v.status === 'active').length)} />
        <KpiCard label="Unique vendors (invoiced)" value={String(vendorSpend.length)} />
      </div>
      <div className="report-card">
        <h3>Top vendors by invoice count</h3>
        {vendorSpend.length === 0 ? (
          <p className="muted">No invoice data yet.</p>
        ) : (
          <div className="vendor-bars">
            {vendorSpend.slice(0, 15).map((v) => (
              <div key={v.name} className="vendor-bar-row">
                <span className="vendor-bar-label" title={v.name}>{v.name}</span>
                <div className="vendor-bar-track">
                  <div
                    className="vendor-bar-fill"
                    style={{ width: `${(v.count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="vendor-bar-value">{v.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="report-card">
        <h3>Spend by vendor</h3>
        {vendorSpend.length === 0 ? (
          <p className="muted">No data.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Vendor</th><th className="num">Invoices</th><th className="num">Spend</th></tr>
            </thead>
            <tbody>
              {vendorSpend.map((v) => (
                <tr key={v.name}>
                  <td>{v.name}</td>
                  <td className="num">{v.count}</td>
                  <td className="num">
                    {Object.entries(v.totalsByCurrency).map(([cur, minor]) => (
                      <span key={cur} className="spend-tag">{formatMoney(String(minor), cur)}</span>
                    ))}
                    {Object.keys(v.totalsByCurrency).length === 0 && '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
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
    <div className="report-panel">
      <div className="report-kpi-row">
        <KpiCard label="Approval rate" value={`${metrics.approvalRate}%`} tone="ok" />
        <KpiCard label="Rejection rate" value={`${metrics.rejectionRate}%`} tone="bad" />
        <KpiCard label="Hold/exception rate" value={`${metrics.holdRate}%`} tone="warn" />
        <KpiCard label="Pending review" value={String(metrics.pending)} />
      </div>
      <div className="report-grid">
        <div className="report-card">
          <h3>Approval funnel</h3>
          <FunnelChart
            steps={[
              { label: 'Received', value: metrics.total },
              { label: 'Approved', value: metrics.approved },
              { label: 'Rejected', value: metrics.rejected },
              { label: 'On hold', value: metrics.onHold },
              { label: 'Exception', value: metrics.exception },
            ]}
          />
        </div>
        <div className="report-card">
          <h3>Outcome breakdown</h3>
          <DonutChart
            segments={[
              { label: 'Approved', value: metrics.approved, className: 'seg-ok' },
              { label: 'Rejected', value: metrics.rejected, className: 'seg-bad' },
              { label: 'Hold', value: metrics.onHold, className: 'seg-warn' },
              { label: 'Exception', value: metrics.exception, className: 'seg-exception' },
              { label: 'Pending', value: metrics.pending, className: 'seg-pending' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/* ─── Shared chart components ─── */

function KpiCard({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`kpi-card${tone ? ` kpi-${tone}` : ''}`}>
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
    </div>
  );
}

function BarChart({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="bar-chart">
      {data.map((d) => (
        <div key={d.label} className="bar-row">
          <span className="bar-label">{d.label}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
          <span className="bar-value">{d.value}</span>
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
    <div className="pipeline-chart">
      {counts.map((c, i) => (
        <div key={c.label} className="pipeline-step">
          <div className="pipeline-bar" style={{ height: `${Math.max((c.value / max) * 100, 4)}%` }} />
          <span className="pipeline-label">{c.label}</span>
          <span className="pipeline-count">{c.value}</span>
          {i < counts.length - 1 && <span className="pipeline-arrow">→</span>}
        </div>
      ))}
    </div>
  );
}

function FunnelChart({ steps }: { steps: { label: string; value: number }[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="funnel-chart">
      {steps.map((step, i) => (
        <div key={step.label} className="funnel-row" style={{ '--w': `${Math.max((step.value / max) * 100, 20)}%` } as React.CSSProperties}>
          <div className="funnel-bar">{step.label}: {step.value}</div>
          {i < steps.length - 1 && <div className="funnel-connector" />}
        </div>
      ))}
    </div>
  );
}

interface Segment { label: string; value: number; className: string }

function DonutChart({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return <p className="muted">No data.</p>;

  let cumulative = 0;
  const arcs = segments.filter((s) => s.value > 0).map((seg) => {
    const pct = (seg.value / total) * 100;
    const start = cumulative;
    cumulative += pct;
    return { ...seg, pct, start };
  });

  const gradientStops = arcs.map((a) => {
    const color =
      a.className === 'seg-ok' ? 'var(--ok)' :
      a.className === 'seg-bad' ? 'var(--bad)' :
      a.className === 'seg-warn' ? 'var(--warn)' :
      a.className === 'seg-exception' ? 'var(--bad)' :
      'var(--muted)';
    return `${color} ${a.start}% ${a.start + a.pct}%`;
  }).join(', ');

  return (
    <div className="donut-container">
      <div
        className="donut"
        style={{ background: `conic-gradient(${gradientStops})` }}
        role="img"
        aria-label={`Outcome: ${arcs.map((a) => `${a.label} ${a.pct.toFixed(0)}%`).join(', ')}`}
      >
        <div className="donut-hole">
          <span className="donut-total">{total}</span>
          <span className="donut-label">total</span>
        </div>
      </div>
      <div className="donut-legend">
        {arcs.map((a) => (
          <div key={a.label} className="donut-legend-item">
            <span className={`donut-swatch ${a.className}`} />
            <span>{a.label}</span>
            <span className="muted">{a.value} ({a.pct.toFixed(0)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}
