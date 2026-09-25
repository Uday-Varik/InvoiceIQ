'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
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
import { useBackend } from './backend';

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
    <div className="dashboard">
      {summary && <SummaryCards summary={summary} onPick={(state) => apply({ ...applied, state })} active={applied.state} />}

      <form className="filters" onSubmit={onSubmit} aria-label="Filter invoices">
        <label>
          Search
          <input type="search" placeholder="Vendor, invoice number or file" maxLength={100} {...field('q')} />
        </label>
        <label>
          State
          <select {...field('state')}>
            <option value="">Any</option>
            {INVOICE_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s as InvoiceState]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Currency
          <input placeholder="USD" maxLength={3} size={4} {...field('currency')} />
          {errors.currency && <span className="error small">{errors.currency}</span>}
        </label>
        <label>
          Invoice date from
          <input type="date" {...field('dateFrom')} />
        </label>
        <label>
          to
          <input type="date" {...field('dateTo')} />
          {errors.dateTo && <span className="error small">{errors.dateTo}</span>}
        </label>
        <label>
          Total from
          <input inputMode="decimal" placeholder="0.00" {...field('minTotal')} />
          {errors.minTotal && <span className="error small">{errors.minTotal}</span>}
        </label>
        <label>
          to
          <input inputMode="decimal" placeholder="0.00" {...field('maxTotal')} />
          {errors.maxTotal && <span className="error small">{errors.maxTotal}</span>}
        </label>
        <div className="buttons">
          <button className="btn btn-primary" type="submit" disabled={Object.keys(errors).length > 0}>
            Apply
          </button>
          {activeFilterCount(applied) > 0 && (
            <button
              className="btn"
              type="button"
              onClick={() => {
                setDraft(EMPTY_FILTERS);
                apply(EMPTY_FILTERS);
              }}
            >
              Clear
            </button>
          )}
          <span className="spacer" />
          <a className="btn" href={exportUrl('csv', query)} download>
            Export CSV
          </a>
          <a className="btn" href={exportUrl('json', query)} download>
            Export JSON
          </a>
        </div>
      </form>

      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && !loading && <p className="muted">No invoices match these filters.</p>}
      {items && items.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Vendor</th>
              <th>Invoice date</th>
              <th>Due</th>
              <th className="num">Total</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {items.map((inv) => (
              <tr key={inv.id}>
                <td>
                  <Link href={`/invoices/${inv.id}`}>{inv.invoiceNumber ?? inv.document?.filename ?? inv.id.slice(0, 8)}</Link>
                  {inv.corrections && inv.corrections.length > 0 && (
                    <span className="badge" title={`Corrected: ${inv.corrections.join(', ')}`}>
                      edited
                    </span>
                  )}
                </td>
                <td>{inv.vendorName ?? '—'}</td>
                <td>{inv.invoiceDate ?? '—'}</td>
                <td>{inv.dueDate ?? '—'}</td>
                <td className="num">{inv.total ? formatMoney(inv.total.amountMinor, inv.total.currency) : '—'}</td>
                <td>
                  <span className={`pill pill-${inv.state.toLowerCase()}`}>{STATE_LABEL[inv.state]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="buttons">
        {cursor && (
          <button className="btn" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
        {items && <span className="muted small">{summary ? `Showing ${items.length} of ${summary.count}` : `Showing ${items.length}`}</span>}
      </div>
    </div>
  );
}

function SummaryCards({ summary, onPick, active }: { summary: InvoiceSummary; onPick: (state: InvoiceState | '') => void; active: string }) {
  const count = (s: InvoiceState) => summary.byState.find((r) => r.state === s)?.count ?? 0;
  return (
    <div className="cards">
      <button className={`card${active === '' ? ' card-active' : ''}`} onClick={() => onPick('')}>
        <span className="card-value">{summary.count}</span>
        <span className="card-label">All invoices</span>
      </button>
      {HEADLINE.map((s) => (
        <button key={s} className={`card${active === s ? ' card-active' : ''}`} onClick={() => onPick(s)}>
          <span className="card-value">{count(s)}</span>
          <span className="card-label">{STATE_LABEL[s]}</span>
        </button>
      ))}
      {summary.byCurrency.map((c) => (
        <div key={c.currency} className="card card-static" title={`${c.count} invoice${c.count === 1 ? '' : 's'}`}>
          <span className="card-value">{formatMoney(c.amountMinor, c.currency)}</span>
          <span className="card-label">
            Total in {c.currency} ({c.count})
          </span>
        </div>
      ))}
    </div>
  );
}
